import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const {
  download,
  fetchText,
  install,
  parseChecksum,
  MAX_REDIRECTS,
} = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    callback: (error: Error | null) => void,
    options?: {
      get?: (
        url: string,
        options: { signal: AbortSignal },
        callback: (response: FakeResponse) => void,
      ) => PassThrough
      expectedChecksum?: string
      preResponseTimeoutMs?: number
      bodyInactivityTimeoutMs?: number
    },
  ) => void
  fetchText: (
    url: string,
    callback: (error: Error | null, contents?: string) => void,
    redirectCount?: number,
    get?: (
      url: string,
      options: { signal: AbortSignal },
      callback: (response: FakeResponse) => void,
    ) => PassThrough,
    timeoutOptions?: { preResponseTimeoutMs?: number; bodyInactivityTimeoutMs?: number },
  ) => void
  install: (options?: {
    platform?: NodeJS.Platform
    arch?: string
    directory?: string
    fetchChecksum?: (
      url: string,
      callback: (error: Error | null, contents?: string) => void,
    ) => void
    hashExistingFile?: (
      filename: string,
      callback: (error: Error | null, checksum?: string) => void,
    ) => void
    downloadFile?: (
      url: string,
      dest: string,
      checksum: string,
      callback: (error: Error | null) => void,
    ) => void
    strict?: boolean
  }) => Promise<void>
  parseChecksum: (contents: string, binaryName: string) => string
  MAX_REDIRECTS: number
}
const { version } = require('../package.json') as { version: string }

const binaryName = 'lingua_rs.darwin-arm64.node'
const releaseUrl = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
const checksumOf = (contents: Buffer | string): string =>
  createHash('sha256').update(contents).digest('hex')
const checksumFile = (checksum: string): string => `${checksum}  ${binaryName}\n`

class FakeResponse extends PassThrough {
  statusCode: number
  headers: { location?: string }
  resumeSpy = vi.fn()

  constructor(statusCode: number, location?: string) {
    super()
    this.statusCode = statusCode
    this.headers = { location }
  }

  override resume(): this {
    this.resumeSpy()
    return super.resume()
  }
}

function redirectingGet(
  responses: FakeResponse[],
): [
  (
    url: string,
    options: { signal: AbortSignal },
    callback: (response: FakeResponse) => void,
  ) => PassThrough,
  ReturnType<typeof vi.fn>,
] {
  const requestUrls = vi.fn()
  const get = (
    url: string,
    _options: { signal: AbortSignal },
    callback: (response: FakeResponse) => void,
  ): PassThrough => {
    requestUrls(url)
    const response = responses.shift()
    if (!response) throw new Error(`Missing response for ${url}`)
    callback(response)
    return new PassThrough()
  }
  return [get, requestUrls]
}

describe('postinstall request timeouts', () => {
  it('uses a 30-second timeout by default', async () => {
    vi.useFakeTimers()
    const request = new PassThrough()
    const get = vi.fn(() => request)
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/checksum',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
      )
    })

    try {
      const timedOut = expect(fetched).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        timeoutMs: 30_000,
      })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(request.destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await timedOut
      expect(request.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a request that never receives response headers', async () => {
    vi.useFakeTimers()
    const request = new PassThrough()
    let signal: AbortSignal | undefined
    const get = vi.fn((_url, options, _callback) => {
      signal = options.signal
      return request
    })
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/checksum',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
        { preResponseTimeoutMs: 10, bodyInactivityTimeoutMs: 10 },
      )
    })

    try {
      const timedOut = expect(fetched).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        phase: 'pre-response',
        url: 'https://example.test/checksum',
        timeoutMs: 10,
        message:
          'lingua-rs timed out after 10ms waiting for pre-response from https://example.test/checksum',
      })
      await vi.advanceTimersByTimeAsync(10)
      await timedOut
      expect(request.destroyed).toBe(true)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a checksum response that stops producing body data', async () => {
    vi.useFakeTimers()
    const response = new FakeResponse(200)
    const request = new PassThrough()
    let signal: AbortSignal | undefined
    const get = vi.fn((_url, options, callback) => {
      signal = options.signal
      callback(response)
      return request
    })
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/checksum',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
        { preResponseTimeoutMs: 10, bodyInactivityTimeoutMs: 10 },
      )
    })
    response.write('partial')

    try {
      const timedOut = expect(fetched).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        phase: 'body',
        url: 'https://example.test/checksum',
        timeoutMs: 10,
        message:
          'lingua-rs timed out after 10ms waiting for body from https://example.test/checksum',
      })
      await vi.advanceTimersByTimeAsync(10)
      await timedOut
      expect(response.destroyed).toBe(true)
      expect(request.destroyed).toBe(true)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a checksum response that closes before it ends', async () => {
    const response = new FakeResponse(200)
    const request = new PassThrough()
    const get = (
      _url: string,
      _options: { signal: AbortSignal },
      callback: (response: FakeResponse) => void,
    ) => {
      callback(response)
      return request
    }
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/checksum',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
      )
    })

    response.write('partial')
    response.destroy()

    await expect(fetched).rejects.toThrow(
      'Response closed before completion fetching https://example.test/checksum',
    )
  })

  it('resets the body timeout when checksum data continues arriving', async () => {
    vi.useFakeTimers()
    const response = new FakeResponse(200)
    const request = new PassThrough()
    const get = (
      _url: string,
      _options: { signal: AbortSignal },
      callback: (response: FakeResponse) => void,
    ) => {
      callback(response)
      return request
    }
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/checksum',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
        { preResponseTimeoutMs: 10, bodyInactivityTimeoutMs: 10 },
      )
    })

    try {
      response.write('one')
      await vi.advanceTimersByTimeAsync(9)
      response.write('two')
      await vi.advanceTimersByTimeAsync(9)
      response.end('three')
      await expect(fetched).resolves.toBe('onetwothree')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares the pre-response deadline across redirect hops', async () => {
    vi.useFakeTimers()
    const redirect = new FakeResponse(302, 'https://example.test/final')
    const requests = [new PassThrough(), new PassThrough()]
    const requestUrls = vi.fn()
    const get = (
      url: string,
      _options: { signal: AbortSignal },
      callback: (response: FakeResponse) => void,
    ) => {
      requestUrls(url)
      if (url.endsWith('/release')) setTimeout(() => callback(redirect), 6)
      return requests.shift() as PassThrough
    }
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/release',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
        { preResponseTimeoutMs: 10, bodyInactivityTimeoutMs: 10 },
      )
    })

    try {
      const timedOut = expect(fetched).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        phase: 'pre-response',
        url: 'https://example.test/final',
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(9)
      expect(requestUrls).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await timedOut
      expect(redirect.destroyed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a partial native artifact when its response stalls', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, 'lingua_rs.test.node')
    const previousArtifact = Buffer.from('previous artifact')
    const response = new FakeResponse(200)
    const request = new PassThrough()
    const get = (
      _url: string,
      _options: { signal: AbortSignal },
      callback: (response: FakeResponse) => void,
    ) => {
      callback(response)
      return request
    }

    try {
      await writeFile(destination, previousArtifact)
      const downloadFinished = new Promise<Error | null>((resolve) => {
        download('https://example.test/binary', destination, resolve, {
          get,
          expectedChecksum: checksumOf('complete artifact'),
          preResponseTimeoutMs: 10,
          bodyInactivityTimeoutMs: 10,
        })
      })
      response.write('partial artifact')
      await vi.advanceTimersByTimeAsync(10)

      await expect(downloadFinished).resolves.toMatchObject({
        code: 'ETIMEDOUT',
        phase: 'body',
        url: 'https://example.test/binary',
        timeoutMs: 10,
      })
      expect(response.destroyed).toBe(true)
      await expect(access(`${destination}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(destination)).resolves.toEqual(previousArtifact)
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
