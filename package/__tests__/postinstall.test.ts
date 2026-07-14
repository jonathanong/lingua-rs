import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { download, MAX_REDIRECTS } = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    callback: (error: Error | null) => void,
    redirectCount?: number,
    get?: (url: string, callback: (response: FakeResponse) => void) => EventEmitter,
  ) => void
  MAX_REDIRECTS: number
}

class FakeResponse extends EventEmitter {
  statusCode: number
  headers: { location?: string }
  resume = vi.fn()

  constructor(statusCode: number, location?: string) {
    super()
    this.statusCode = statusCode
    this.headers = { location }
  }
}

function redirectingGet(
  responses: FakeResponse[],
): [
  (url: string, callback: (response: FakeResponse) => void) => EventEmitter,
  ReturnType<typeof vi.fn>,
] {
  const requestUrls = vi.fn()
  const get = (url: string, callback: (response: FakeResponse) => void): EventEmitter => {
    requestUrls(url)
    const response = responses.shift()
    if (!response) throw new Error(`Missing response for ${url}`)
    callback(response)
    return new EventEmitter()
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

    expect(redirect.resume).toHaveBeenCalledOnce()
    expect(requestUrls.mock.calls).toEqual([
      ['https://example.test/release'],
      ['https://example.test/binary'],
    ])
    expect(redirect.resume.mock.invocationCallOrder[0]).toBeLessThan(
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
    expect(redirects.every((response) => response.resume.mock.calls.length === 1)).toBe(true)
    expect(error?.message).toBe(`Too many redirects fetching https://example.test/redirect-6`)
  })
})
