import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

type Callback<T = undefined> = (error: Error | null, value?: T) => void
type Get = (
  url: string,
  options: { signal: AbortSignal },
  callback: (response: PassThrough & { statusCode: number; headers: object }) => void,
) => PassThrough

const { download, fetchText } = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    cb: Callback,
    o: { get: Get; signal?: unknown; expectedChecksum?: string },
  ) => void
  fetchText: (url: string, cb: Callback<string>, n: number, get: Get, o: { signal: unknown }) => void
}
const { downloadTimeoutMs } = require('../install-env') as {
  downloadTimeoutMs: (env: Record<string, string>) => number
}
const { withRetry } = require('../retry') as {
  withRetry: (label: string, op: (signal: AbortSignal) => Promise<unknown>, o: object) => Promise<unknown>
}

const exists = (path: string) => access(path).then(() => true, () => false)
const reason = new Error('aborted by test')

function fakeGet(onResponse?: (res: PassThrough) => void): Get {
  return (_url, _options, callback) => {
    const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
    setImmediate(() => {
      callback(res)
      res.write('partial')
      onResponse?.(res)
    })
    return new PassThrough()
  }
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'lingua-rs-abort-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('download timeout clamp', () => {
  it('clamps values above the setTimeout maximum', () => {
    expect(downloadTimeoutMs({ LINGUA_RS_DOWNLOAD_TIMEOUT_MS: '99999999999' })).toBe(2_147_483_647)
  })
})

describe('withRetry abort signal', () => {
  it('passes a signal that is aborted with the budget error on deadline', async () => {
    let seen: AbortSignal | undefined
    const hang = (signal: AbortSignal) => {
      seen = signal
      return new Promise<never>(() => undefined)
    }
    await expect(withRetry('op', hang, { deadline: Date.now() + 20 })).rejects.toMatchObject({
      code: 'EBUDGET',
    })
    expect(seen?.aborted).toBe(true)
    expect(seen?.reason).toMatchObject({ code: 'EBUDGET' })
  })

  it('passes a live signal when there is no deadline', async () => {
    let seen: AbortSignal | undefined
    await withRetry('op', async (signal) => { seen = signal }, {})
    expect(seen?.aborted).toBe(false)
  })
})

describe('aborting requests', () => {
  it('fails immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(reason)
    const get = (() => { throw new Error('should not request') }) as unknown as Get
    const error = await new Promise((resolve) =>
      fetchText('https://example.test/x', resolve, 0, get, { signal: controller.signal }),
    )
    expect(error).toBe(reason)
  })

  it('destroys the response and removes the tmp file when aborted mid-download', async () => {
    await withDir(async (dir) => {
      const dest = join(dir, 'binary')
      const controller = new AbortController()
      let response: PassThrough | undefined
      const get = fakeGet((res) => {
        response = res
        controller.abort(reason)
      })
      const error = await new Promise((resolve) =>
        download('https://example.test/b', dest, resolve, { get, signal: controller.signal }),
      )
      expect(error).toBe(reason)
      expect(response?.destroyed).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await exists(`${dest}.tmp`)).toBe(false)
      expect(await exists(dest)).toBe(false)
    })
  })

  for (const expectedChecksum of [undefined, 'a'.repeat(64)]) {
    it(`never installs a finished download that was aborted (checksum: ${Boolean(expectedChecksum)})`, async () => {
      await withDir(async (dir) => {
        const dest = join(dir, 'binary')
        const signal = { aborted: false, reason, addEventListener: () => undefined }
        const get = fakeGet((res) => {
          res.once('end', () => { signal.aborted = true })
          res.end()
        })
        const error = await new Promise((resolve) =>
          download('https://example.test/b', dest, resolve, { get, signal, expectedChecksum }),
        )
        expect(error).toBe(reason)
        expect(await exists(`${dest}.tmp`)).toBe(false)
        expect(await exists(dest)).toBe(false)
      })
    })
  }
})
