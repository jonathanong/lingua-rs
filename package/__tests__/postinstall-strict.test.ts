import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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

describe('LINGUA_RS_STRICT_INSTALL', () => {
  it.each(['1', 'true', 'TRUE', ' True ', 'yes', 'on', 'strict'])(
    'enables strict mode for %j, so an unexpected value fails closed',
    value => {
      expect(isStrictInstall({ LINGUA_RS_STRICT_INSTALL: value })).toBe(true)
    },
  )

  it.each(['0', 'false', 'FALSE', ' false ', '', '  '])(
    'keeps best-effort mode for %j',
    value => {
      expect(isStrictInstall({ LINGUA_RS_STRICT_INSTALL: value })).toBe(false)
    },
  )

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

      expect(run).toHaveBeenCalledWith({ strict: true, timeoutMs: 90_000 })
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

      expect(run).toHaveBeenCalledWith({ strict: true, timeoutMs: 90_000 })
      expect(process.exitCode).toBeUndefined()
    })

    it('runs a best-effort install by default and reports unexpected failures', async () => {
      const error = vi.spyOn(console, 'error').mockReturnValue(undefined)
      const run = vi.fn(async () => {
        throw new Error('unexpected')
      })

      await main({ env: {}, run })

      expect(run).toHaveBeenCalledWith({ strict: false, timeoutMs: 90_000 })
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

const packageDirectory = join(import.meta.dirname, '..')
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
    expect(result.stderr).toContain('attempt 1 of 7 failed (HTTP 500 fetching')
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
