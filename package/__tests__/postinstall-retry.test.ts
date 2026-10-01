import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

type Get = (
  url: string,
  options: { signal: AbortSignal },
  callback: (response: FakeResponse) => void,
) => PassThrough
type Callback<T = undefined> = (error: Error | null, value?: T) => void
type InstallOptions = {
  platform?: NodeJS.Platform
  arch?: string
  directory?: string
  fetchChecksum?: (url: string, callback: Callback<string>) => void
  hashExistingFile?: (filename: string, callback: Callback<string>) => void
  downloadFile?: (url: string, dest: string, checksum: string, callback: Callback) => void
  strict?: boolean
  retry?: { maxAttempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }
}

const { download, fetchText, install, isStrictInstall, main } = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    callback: Callback,
    options?: { get?: Get; expectedChecksum?: string },
  ) => void
  fetchText: (url: string, callback: Callback<string>, redirectCount?: number, get?: Get) => void
  install: (options?: InstallOptions) => Promise<void>
  isStrictInstall: (env?: Record<string, string | undefined>) => boolean
  main: (options?: {
    env?: Record<string, string | undefined>
    run?: (options: { strict: boolean }) => Promise<void>
  }) => Promise<void>
}
const { isRetryable } = require('../retry') as { isRetryable: (error: unknown) => boolean }
const { version } = require('../package.json') as { version: string }
const packageJson = require('../package.json') as { files: string[] }

const binaryName = 'lingua_rs.darwin-arm64.node'
const releaseUrl = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
const checksumOf = (contents: Buffer | string): string =>
  createHash('sha256').update(contents).digest('hex')
const checksumFile = (checksum: string): string => `${checksum}  ${binaryName}\n`

class FakeResponse extends PassThrough {
  statusCode: number
  headers: Record<string, string>

  constructor(statusCode: number, headers: Record<string, string> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }
}

function respondWith(response: FakeResponse): Get {
  return (_url, _options, callback) => {
    callback(response)
    return new PassThrough()
  }
}

function failure(message: string, properties: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), properties)
}

const transient = () => failure('HTTP 500 fetching https://example.test/x', { statusCode: 500 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('request failures carry what the retry policy needs', () => {
  it('records the status and Retry-After of an HTTP error', async () => {
    const response = new FakeResponse(503, { 'retry-after': '7' })

    const error = await new Promise<Error | null>(resolve =>
      fetchText('https://example.test/checksum', resolve, 0, respondWith(response)),
    )

    expect(error).toMatchObject({
      message: 'HTTP 503 fetching https://example.test/checksum',
      statusCode: 503,
      retryAfter: '7',
    })
    expect(isRetryable(error)).toBe(true)
  })

  it('does not retry a missing release asset', async () => {
    const error = await new Promise<Error | null>(resolve =>
      download('https://example.test/binary', '/unused', resolve, {
        get: respondWith(new FakeResponse(404)),
      }),
    )

    expect(error).toMatchObject({ statusCode: 404 })
    expect(isRetryable(error)).toBe(false)
  })

  it('retries a checksum response that closes early', async () => {
    const response = new FakeResponse(200)
    const fetched = new Promise<Error | null>(resolve =>
      fetchText('https://example.test/checksum', resolve, 0, respondWith(response)),
    )

    response.write('partial')
    response.destroy()

    const error = await fetched
    expect(error?.message).toBe(
      'Response closed before completion fetching https://example.test/checksum',
    )
    expect(isRetryable(error)).toBe(true)
  })

  it('retries a binary body that ends early', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-retry-'))
    const response = new FakeResponse(200)

    try {
      const finished = new Promise<Error | null>(resolve =>
        download('https://example.test/binary', join(directory, binaryName), resolve, {
          get: respondWith(response),
          expectedChecksum: checksumOf('complete'),
        }),
      )
      response.write('partial')
      response.destroy()

      const error = await finished
      expect(error).toBeInstanceOf(Error)
      expect(isRetryable(error)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a checksum mismatch because the body may have been truncated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-retry-'))
    const response = new FakeResponse(200)

    try {
      const finished = new Promise<Error | null>(resolve =>
        download('https://example.test/binary', join(directory, binaryName), resolve, {
          get: respondWith(response),
          expectedChecksum: checksumOf('complete'),
        }),
      )
      response.end('trunc')

      const error = await finished
      expect(error?.message).toBe('Checksum mismatch downloading https://example.test/binary')
      expect(isRetryable(error)).toBe(true)
      await expect(access(join(directory, `${binaryName}.tmp`))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('request failures from a real socket', () => {
  async function withServer<T>(
    handler: http.RequestListener,
    run: (base: string) => Promise<T>,
  ): Promise<T> {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }
  const httpGet = http.get as unknown as Get

  it('retries a body the server cuts off mid-transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-retry-'))

    try {
      const error = await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-length': '100' })
          response.write('partial')
          setTimeout(() => response.socket?.destroy(), 10)
        },
        (base) =>
          new Promise<Error | null>((resolve) =>
            download(`${base}/binary`, join(directory, binaryName), resolve, {
              get: httpGet,
              expectedChecksum: checksumOf('complete'),
            }),
          ),
      )

      expect(error).toMatchObject({ code: 'ECONNRESET' })
      expect(isRetryable(error)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a connection the server drops before responding', async () => {
    const error = await withServer(
      (request) => request.socket.destroy(),
      (base) =>
        new Promise<Error | null>((resolve) => fetchText(`${base}/sum`, resolve, 0, httpGet)),
    )

    expect(error).toMatchObject({ code: 'ECONNRESET', message: 'socket hang up' })
    expect(isRetryable(error)).toBe(true)
  })

  it('retries a refused connection', async () => {
    const base = await withServer(
      () => undefined,
      async (url) => url,
    )

    const error = await new Promise<Error | null>((resolve) =>
      fetchText(`${base}/sum`, resolve, 0, httpGet),
    )

    expect(error).toMatchObject({ code: 'ECONNREFUSED' })
    expect(isRetryable(error)).toBe(true)
  })
})

describe('install retries', () => {
  const sleep = vi.fn(async (_ms: number) => undefined)
  const retry = { sleep, random: () => 0 }
  const expectedChecksum = checksumOf('current-version')

  const quiet = () => {
    sleep.mockClear()
    vi.spyOn(console, 'log').mockReturnValue(undefined)
    return vi.spyOn(console, 'warn').mockReturnValue(undefined)
  }
  const missingBinary = (_filename: string, callback: Callback<string>) =>
    callback(new Error('ENOENT'))

  it('retries a transient checksum failure and then installs', async () => {
    const warn = quiet()
    const fetchChecksum = vi
      .fn<(url: string, callback: Callback<string>) => void>()
      .mockImplementationOnce((_url, callback) => callback(transient()))
      .mockImplementationOnce((_url, callback) => callback(transient()))
      .mockImplementation((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const downloadFile = vi.fn((_url, _dest, _checksum, callback: Callback) => callback(null))

    await install({
      platform: 'darwin',
      arch: 'arm64',
      fetchChecksum,
      hashExistingFile: missingBinary,
      downloadFile,
      retry,
    })

    expect(fetchChecksum).toHaveBeenCalledTimes(3)
    expect(fetchChecksum).toHaveBeenLastCalledWith(`${releaseUrl}.sha256`, expect.any(Function))
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]])
    expect(downloadFile).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      `[lingua-rs] fetching ${binaryName}.sha256: attempt 1 of 4 failed ` +
        '(HTTP 500 fetching https://example.test/x); retrying in 1.0s',
    )
  })

  it('retries a transient binary failure without refetching the checksum', async () => {
    quiet()
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) =>
      callback(null, checksumFile(expectedChecksum)),
    )
    const downloadFile = vi
      .fn<(url: string, dest: string, checksum: string, callback: Callback) => void>()
      .mockImplementationOnce((_url, _dest, _checksum, callback) =>
        callback(failure('read ECONNRESET', { code: 'ECONNRESET' })),
      )
      .mockImplementationOnce((_url, _dest, _checksum, callback) =>
        callback(failure('Checksum mismatch', { code: 'ECHECKSUM' })),
      )
      .mockImplementation((_url, _dest, _checksum, callback) => callback(null))

    await install({
      platform: 'darwin',
      arch: 'arm64',
      fetchChecksum,
      hashExistingFile: missingBinary,
      downloadFile,
      strict: true,
      retry,
    })

    expect(fetchChecksum).toHaveBeenCalledOnce()
    expect(downloadFile).toHaveBeenCalledTimes(3)
    expect(downloadFile).toHaveBeenLastCalledWith(
      releaseUrl,
      expect.stringContaining(binaryName),
      expectedChecksum,
      expect.any(Function),
    )
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]])
  })

  it('does not retry a missing checksum file', async () => {
    const warn = quiet()
    const missing = failure('HTTP 404 fetching x', { statusCode: 404 })
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) => callback(missing))
    const downloadFile = vi.fn()

    await expect(
      install({ platform: 'darwin', arch: 'arm64', fetchChecksum, downloadFile, retry }),
    ).resolves.toBeUndefined()
    await expect(
      install({
        platform: 'darwin',
        arch: 'arm64',
        fetchChecksum,
        downloadFile,
        strict: true,
        retry,
      }),
    ).rejects.toBe(missing)

    expect(fetchChecksum).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
    expect(downloadFile).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: HTTP 404 fetching x`,
    )
  })

  it('does not retry an invalid checksum file', async () => {
    const warn = quiet()
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) =>
      callback(null, `${expectedChecksum}  another.node\n`),
    )

    await expect(
      install({ platform: 'darwin', arch: 'arm64', fetchChecksum, strict: true, retry }),
    ).rejects.toThrow(`Invalid checksum for ${binaryName}`)

    expect(fetchChecksum).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('gives up on the checksum after four attempts: best-effort by default, fatal when strict', async () => {
    const warn = quiet()
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) => callback(transient()))
    const options = { platform: 'darwin', arch: 'arm64', fetchChecksum, retry } as const

    await expect(install(options)).resolves.toBeUndefined()
    expect(fetchChecksum).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000]])
    expect(warn).toHaveBeenLastCalledWith(
      `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: ` +
        'HTTP 500 fetching https://example.test/x',
    )

    fetchChecksum.mockClear()
    await expect(install({ ...options, strict: true })).rejects.toMatchObject({ statusCode: 500 })
    expect(fetchChecksum).toHaveBeenCalledTimes(4)
  })

  it('gives up on the binary after exhausting a custom attempt limit', async () => {
    const warn = quiet()
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) =>
      callback(null, checksumFile(expectedChecksum)),
    )
    const downloadFile = vi.fn((_url, _dest, _checksum, callback: Callback) =>
      callback(transient()),
    )
    const log = vi.mocked(console.log)

    await expect(
      install({
        platform: 'darwin',
        arch: 'arm64',
        fetchChecksum,
        hashExistingFile: missingBinary,
        downloadFile,
        retry: { ...retry, maxAttempts: 2 },
      }),
    ).resolves.toBeUndefined()

    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual([[1_000]])
    expect(warn).toHaveBeenLastCalledWith(
      `[lingua-rs] failed to download ${binaryName}.\n` +
        '  HTTP 500 fetching https://example.test/x\n' +
        '  The existing binary, if any, was left unchanged.',
    )
    expect(log).not.toHaveBeenCalledWith(`[lingua-rs] installed ${binaryName}`)
  })

  it('uses real timers to back off by default', async () => {
    vi.useFakeTimers()
    quiet()
    const fetchChecksum = vi
      .fn<(url: string, callback: Callback<string>) => void>()
      .mockImplementationOnce((_url, callback) => callback(transient()))
      .mockImplementation((_url, callback) => callback(null, checksumFile(expectedChecksum)))

    try {
      const installed = install({
        platform: 'darwin',
        arch: 'arm64',
        fetchChecksum,
        hashExistingFile: (_filename, callback) => callback(null, expectedChecksum),
      })
      await vi.advanceTimersByTimeAsync(1_249)
      await installed
      expect(fetchChecksum).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an unsupported platform, and fails when strict', async () => {
    const warn = quiet()
    const fetchChecksum = vi.fn()
    const message =
      '[lingua-rs] unsupported platform freebsd-x64 — language detection will fail at runtime'

    await expect(
      install({ platform: 'freebsd', arch: 'x64', fetchChecksum }),
    ).resolves.toBeUndefined()
    await expect(
      install({ platform: 'freebsd', arch: 'x64', fetchChecksum, strict: true }),
    ).rejects.toThrow('unsupported platform freebsd-x64')

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(message)
    expect(fetchChecksum).not.toHaveBeenCalled()
  })

  it('replaces a stale binary after a transient failure', async () => {
    quiet()
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-retry-'))
    const destination = join(directory, binaryName)
    const current = Buffer.from('current-version')
    const fetchChecksum = (_url: string, callback: Callback<string>) =>
      callback(null, checksumFile(checksumOf(current)))
    let attempts = 0
    const downloadFile = async (_url: string, dest: string, _sum: string, callback: Callback) => {
      attempts += 1
      if (attempts === 1) return callback(transient())
      await writeFile(dest, current)
      callback(null)
    }

    try {
      await writeFile(destination, 'previous-version')
      await install({
        platform: 'darwin',
        arch: 'arm64',
        directory,
        fetchChecksum,
        downloadFile,
        retry,
      })
      await expect(readFile(destination)).resolves.toEqual(current)
      expect(attempts).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('LINGUA_RS_STRICT_INSTALL', () => {
  it.each(['1', 'true', 'TRUE', ' True '])('enables strict mode for %j', value => {
    expect(isStrictInstall({ LINGUA_RS_STRICT_INSTALL: value })).toBe(true)
  })

  it.each(['0', 'false', '', 'yes', 'strict'])('keeps best-effort mode for %j', value => {
    expect(isStrictInstall({ LINGUA_RS_STRICT_INSTALL: value })).toBe(false)
  })

  it('defaults to best-effort mode and reads process.env', () => {
    expect(isStrictInstall({})).toBe(false)
    vi.stubEnv('LINGUA_RS_STRICT_INSTALL', '1')
    try {
      expect(isStrictInstall()).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  describe('main', () => {
    const previousExitCode = process.exitCode
    afterEach(() => {
      process.exitCode = previousExitCode
    })

    it('runs a strict install and fails the process when it fails', async () => {
      const error = vi.spyOn(console, 'error').mockReturnValue(undefined)
      const run = vi.fn(async () => {
        throw new Error('HTTP 500 fetching x')
      })

      await main({ env: { LINGUA_RS_STRICT_INSTALL: '1' }, run })

      expect(run).toHaveBeenCalledWith({ strict: true })
      expect(process.exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith(
        '[lingua-rs] install failed and LINGUA_RS_STRICT_INSTALL is set, ' +
          'so the install is failing: HTTP 500 fetching x',
      )
    })

    it('leaves the exit code alone when a strict install succeeds', async () => {
      process.exitCode = undefined
      const run = vi.fn(async () => undefined)

      await main({ env: { LINGUA_RS_STRICT_INSTALL: 'true' }, run })

      expect(run).toHaveBeenCalledWith({ strict: true })
      expect(process.exitCode).toBeUndefined()
    })

    it('runs a best-effort install by default and reports unexpected failures', async () => {
      const error = vi.spyOn(console, 'error').mockReturnValue(undefined)
      const run = vi.fn(async () => {
        throw new Error('unexpected')
      })

      await main({ env: {}, run })

      expect(run).toHaveBeenCalledWith({ strict: false })
      expect(process.exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith('[lingua-rs] install failed unexpectedly: unexpected')
    })

    it('installs for the current process by default', async () => {
      vi.stubEnv('LINGUA_RS_STRICT_INSTALL', '')
      vi.spyOn(console, 'warn').mockReturnValue(undefined)
      vi.spyOn(console, 'log').mockReturnValue(undefined)
      vi.spyOn(console, 'error').mockReturnValue(undefined)
      process.exitCode = undefined
      try {
        await expect(main({ run: async () => undefined })).resolves.toBeUndefined()
        expect(process.exitCode).toBeUndefined()
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })
})

const packageDirectory = join(__dirname, '..')
const supportedPlatform = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
].includes(`${process.platform}-${process.arch}`)

// Runs the real script in a child process with a stubbed `https.get`, so these
// cover the entry point, the environment variable and the exit code.
describe.skipIf(!supportedPlatform)('postinstall script', () => {
  const stub = `
const https = require('node:https')
const { PassThrough } = require('node:stream')
const statuses = process.env.STUB_STATUSES.split(',').map(Number)
let requests = 0
https.get = (url, _options, callback) => {
  const response = new PassThrough()
  response.statusCode = statuses[Math.min(requests, statuses.length - 1)]
  response.headers = {}
  requests += 1
  setImmediate(() => callback(response))
  return new PassThrough()
}
`
  let scratch: string
  let preload: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'lingua-rs-entry-'))
    preload = join(scratch, 'stub-https.js')
    await writeFile(preload, stub)
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  function runScript(statuses: string, strict?: string) {
    const env: Record<string, string | undefined> = { ...process.env, STUB_STATUSES: statuses }
    delete env.LINGUA_RS_STRICT_INSTALL
    if (strict !== undefined) env.LINGUA_RS_STRICT_INSTALL = strict
    return spawnSync(
      process.execPath,
      ['--require', preload, join(packageDirectory, 'postinstall.js')],
      { env, encoding: 'utf8', timeout: 30_000 },
    )
  }

  it('fails the install when strict and the checksum is missing', () => {
    const result = runScript('404', '1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('HTTP 404 fetching')
    expect(result.stderr).toContain('LINGUA_RS_STRICT_INSTALL is set, so the install is failing')
  })

  it('stays best-effort by default', () => {
    const result = runScript('404')

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('HTTP 404 fetching')
    expect(result.stderr).not.toContain('install is failing')
  })

  it.each(['0', 'false'])('stays best-effort when the variable is %j', (value) => {
    expect(runScript('404', value).status).toBe(0)
  })

  it('stays alive through a backoff and retries before failing', () => {
    const result = runScript('500,404', '1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('attempt 1 of 4 failed (HTTP 500 fetching')
    expect(result.stderr).toContain('retrying in 1.')
    expect(result.stderr).toContain('HTTP 404 fetching')
  })
})

describe('published files', () => {
  it('lists every local module the install script requires', async () => {
    const source = await readFile(join(packageDirectory, 'postinstall.js'), 'utf8')
    const required = [...source.matchAll(/require\('\.\/([^']+)'\)/g)]
      .map(([, name]) => name as string)
      .filter(name => !name.endsWith('.json'))
      .map(name => (name.endsWith('.js') ? name : `${name}.js`))

    expect(required).toContain('retry.js')
    for (const file of required) {
      expect(packageJson.files).toContain(file)
      await expect(access(join(packageDirectory, file))).resolves.toBeUndefined()
    }
  })
})
