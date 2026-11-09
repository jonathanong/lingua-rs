import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

type Callback = (error: Error | null, value?: PassThrough) => void
type Response = PassThrough & { statusCode: number; headers: object }
type Get = (
  url: string,
  options: { signal: AbortSignal },
  callback: (response: Response) => void,
) => PassThrough

const { request } = require('../request') as {
  request: (url: string, cb: Callback, o: object) => void
}

const ok = (): Response => Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => vi.restoreAllMocks())

describe('request lifecycle edge cases', () => {
  it('reports a get() that throws synchronously', async () => {
    const boom = new Error('invalid url')
    const get: Get = () => {
      throw boom
    }
    const error = await new Promise<Error | null>((resolve) => {
      request('https://example.test/a', resolve, { get })
    })
    expect(error).toBe(boom)
  })

  it('tolerates timers without unref', async () => {
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      ms === 0 ? real(fn, 0) : ({})) as never)
    const res = ok()
    const get: Get = (_url, _options, callback) => {
      callback(res)
      return new PassThrough()
    }
    const delivered = await new Promise<PassThrough | undefined>((resolve) => {
      request('https://example.test/a', (_error, value) => resolve(value), { get })
    })
    expect(delivered).toBe(res)
    res.destroy()
  })

  it('ignores an aborted event that follows a completed response', async () => {
    const res = ok()
    const get: Get = (_url, _options, callback) => {
      setImmediate(() => callback(res))
      return new PassThrough()
    }
    await new Promise<void>((resolve) => {
      request('https://example.test/a', () => resolve(), { get })
    })
    res.emit('end')
    res.emit('aborted')
    await settle()
    expect(res.listenerCount('aborted')).toBe(0)
    res.destroy()
  })

  it('does not destroy a request that was already destroyed when the signal aborts', async () => {
    const req = new PassThrough()
    const controller = new AbortController()
    const get: Get = () => req
    const callback = vi.fn()
    request('https://example.test/a', callback, { get, signal: controller.signal })
    req.destroy()
    const destroy = vi.spyOn(req, 'destroy')
    const stop = new Error('stop')
    controller.abort(stop)
    await settle()
    expect(destroy).not.toHaveBeenCalled()
    expect(callback.mock.calls[0][0]).toBe(stop)
  })

  it('destroys a pending request when the signal aborts', async () => {
    const req = new PassThrough()
    const controller = new AbortController()
    const get: Get = () => req
    request('https://example.test/a', vi.fn(), { get, signal: controller.signal })
    controller.abort(new Error('stop'))
    await settle()
    expect(req.destroyed).toBe(true)
  })
})
