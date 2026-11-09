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
