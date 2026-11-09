import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type Callback<T = undefined> = (error: Error | null, value?: T) => void
type Get = (
  url: string,
  options: { signal: AbortSignal },
  callback: (response: PassThrough) => void,
) => PassThrough

const { download, fetchText, install, parseChecksum } = require('../postinstall') as {
  download: (url: string, dest: string, cb: Callback, o: { get: Get }) => void
  fetchText: (url: string, cb: Callback<string>, n: number, get: Get) => void
  install: (o: object) => Promise<void>
  parseChecksum: (contents: unknown, binaryName: string) => string
}
const { request } = require('../request') as {
  request: (url: string, cb: Callback<PassThrough>, o: object) => void
}

function response(statusCode: number, headers: Record<string, string> = {}): PassThrough {
  return Object.assign(new PassThrough(), { statusCode, headers })
}

// Answers every request with the response built by `make`, delivered on a
// later tick the way a socket would.
function respondWith(make: (url: string) => PassThrough, body?: string | Buffer): Get {
  return (url, _options, callback) => {
    const res = make(url)
    setImmediate(() => {
      callback(res)
      if (body !== undefined) res.end(body)
    })
    return new PassThrough()
  }
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'lingua-rs-gaps-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

afterEach(() => vi.restoreAllMocks())

describe('request edge cases', () => {
  it('reports a redirect without a Location header', async () => {
    const get = respondWith(() => response(302))
    const error = await new Promise<Error | null>((resolve) => {
      fetchText('https://example.test/a', resolve, 0, get)
    })
    expect(error?.message).toBe('HTTP 302 missing Location header fetching https://example.test/a')
  })

  it('times out immediately when the shared pre-response deadline already passed', async () => {
    const get = vi.fn()
    const error = await new Promise<Error | null>((resolve) => {
      request('https://example.test/a', resolve, {
        get,
        preResponseTimeoutMs: 1_234,
        state: { preResponseDeadline: Date.now() - 1 },
      })
    })
    expect(get).not.toHaveBeenCalled()
    expect(error).toMatchObject({ code: 'ETIMEDOUT', phase: 'pre-response', timeoutMs: 1_234 })
  })

  it('surfaces a request error that happens before any response', async () => {
    const boom = new Error('connect failed')
    const get: Get = () => {
      const req = new PassThrough()
      setImmediate(() => req.emit('error', boom))
      return req
    }
    const error = await new Promise<Error | null>((resolve) => {
      request('https://example.test/a', resolve, { get })
    })
    expect(error).toBe(boom)
  })

  it('ignores a request error that arrives after the response was delivered', async () => {
    const res = response(200)
    const req = new PassThrough()
    const get: Get = (_url, _options, callback) => {
      setImmediate(() => {
        callback(res)
        req.emit('error', new Error('late'))
      })
      return req
    }
    const callback = vi.fn()
    request('https://example.test/a', callback, { get })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(null, res)
    res.destroy()
  })
})

describe('transfer edge cases', () => {
  it('rejects a checksum that is not a string', () => {
    expect(() => parseChecksum(undefined, 'x.node')).toThrow(new TypeError('Invalid checksum for x.node'))
  })

  it('stops reading a checksum response that is too large', async () => {
    const get = respondWith(() => response(200), 'a'.repeat(2_000))
    const error = await new Promise<Error | null>((resolve) => {
      fetchText('https://example.test/a.sha256', resolve, 0, get)
    })
    expect(error?.message).toBe('Checksum response too large fetching https://example.test/a.sha256')
  })

  it('reports a rename failure and removes the temporary file', () =>
    withDir(async (dir) => {
      const dest = join(dir, 'occupied')
      await mkdir(join(dest, 'child'), { recursive: true })
      const get = respondWith(() => response(200), 'binary')
      const error = await new Promise<Error | null>((resolve) => {
        download('https://example.test/a', dest, resolve, { get })
      })
      expect(error).toBeInstanceOf(Error)
      await expect(readFile(`${dest}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    }))
})

describe('install defaults', () => {
  it('fetches the checksum and the binary through https.get', () =>
    withDir(async (directory) => {
      const binaryName = 'lingua_rs.darwin-arm64.node'
      const binary = Buffer.from('native binary')
      const checksum = createHash('sha256').update(binary).digest('hex')
      const urls: string[] = []
      vi.spyOn(https, 'get').mockImplementation(((url: string, _o: object, cb: (r: PassThrough) => void) => {
        urls.push(url)
        const res = response(200)
        setImmediate(() => {
          cb(res)
          res.end(url.endsWith('.sha256') ? `${checksum}  ${binaryName}\n` : binary)
        })
        return new PassThrough()
      }) as never)
      vi.spyOn(console, 'log').mockImplementation(() => undefined)

      await install({
        platform: 'darwin',
        arch: 'arm64',
        directory,
        checksums: () => undefined,
        strict: true,
      })

      expect(urls.map((url) => url.endsWith('.sha256'))).toEqual([true, false])
      expect(await readFile(join(directory, binaryName))).toEqual(binary)
    }))
})
