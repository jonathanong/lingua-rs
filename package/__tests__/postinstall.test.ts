import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const { download, MAX_REDIRECTS } = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    callback: (error: Error | null) => void,
    redirectCount?: number,
    get?: (url: string, callback: (response: FakeResponse) => void) => PassThrough,
  ) => void
  MAX_REDIRECTS: number
}

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
  (url: string, callback: (response: FakeResponse) => void) => PassThrough,
  ReturnType<typeof vi.fn>,
] {
  const requestUrls = vi.fn()
  const get = (url: string, callback: (response: FakeResponse) => void): PassThrough => {
    requestUrls(url)
    const response = responses.shift()
    if (!response) throw new Error(`Missing response for ${url}`)
    callback(response)
    return new PassThrough()
  }
  return [get, requestUrls]
}

describe('postinstall download redirects', () => {
  it('drains a redirect response before following its location', async () => {
    const redirect = new FakeResponse(302, 'https://example.test/binary')
    const failure = new FakeResponse(500)
    const [get, requestUrls] = redirectingGet([redirect, failure])

    const error = await new Promise<Error | null>((resolve) => {
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, 0, get)
    })

    expect(redirect.resumeSpy).toHaveBeenCalledOnce()
    expect(requestUrls.mock.calls).toEqual([
      ['https://example.test/release'],
      ['https://example.test/binary'],
    ])
    expect(redirect.resumeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      requestUrls.mock.invocationCallOrder[1],
    )
    expect(error?.message).toBe('HTTP 500 fetching https://example.test/binary')
  })

  it('allows five redirects and rejects the sixth without another request', async () => {
    const redirects = Array.from(
      { length: MAX_REDIRECTS + 1 },
      (_, index) => new FakeResponse(302, `https://example.test/redirect-${index + 1}`),
    )
    const [get, requestUrls] = redirectingGet([...redirects])

    const error = await new Promise<Error | null>((resolve) => {
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, 0, get)
    })

    expect(requestUrls).toHaveBeenCalledTimes(MAX_REDIRECTS + 1)
    expect(redirects.every((response) => response.resumeSpy.mock.calls.length === 1)).toBe(true)
    expect(error?.message).toBe(`Too many redirects fetching https://example.test/redirect-6`)
  })

  it('writes and renames an artifact received after a redirect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, 'lingua_rs.test.node')
    const expectedArtifact = Buffer.from('native-binary-test-data')
    const redirect = new FakeResponse(302, 'https://example.test/binary')
    const success = new FakeResponse(200)
    const [get] = redirectingGet([redirect, success])

    try {
      const downloadFinished = new Promise<Error | null>((resolve) => {
        download('https://example.test/release', destination, resolve, 0, get)
      })
      success.end(expectedArtifact)

      await expect(downloadFinished).resolves.toBeNull()
      await expect(readFile(destination)).resolves.toEqual(expectedArtifact)
      expect(redirect.resumeSpy).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
