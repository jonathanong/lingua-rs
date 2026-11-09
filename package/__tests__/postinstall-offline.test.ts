import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Callback<T = undefined> = (error: Error | null, value?: T) => void
type Env = Record<string, string | undefined>

const { install, main } = require('../postinstall') as {
  install: (options?: Record<string, unknown>) => Promise<void>
  main: (options?: { env?: Env; run?: (o: unknown) => Promise<void> }) => Promise<void>
}
const { loadShippedChecksum } = require('../checksums') as {
  loadShippedChecksum: (dir: string, name: string, read?: () => string) => string | undefined
}
const { downloadTimeoutMs, isSkipDownload } = require('../install-env') as {
  downloadTimeoutMs: (env?: Env) => number
  isSkipDownload: (env?: Env) => boolean
}
const { withRetry } = require('../retry') as {
  withRetry: (label: string, op: () => Promise<unknown>, o?: Record<string, unknown>) => Promise<unknown>
}

const binaryName = 'lingua_rs.darwin-arm64.node'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const platform = { platform: 'darwin', arch: 'arm64' }
const transient = () => Object.assign(new Error('HTTP 504'), { statusCode: 504 })

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'lingua-rs-offline-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('shipped checksums.json', () => {
  it('exits with zero network calls when the local binary matches', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, binaryName), 'current')
      await writeFile(join(dir, 'checksums.json'), JSON.stringify({ [binaryName]: sha('current') }))
      const fetchChecksum = vi.fn()
      const downloadFile = vi.fn()
      const get = vi.spyOn(require('node:https'), 'get')
      vi.spyOn(console, 'log').mockReturnValue(undefined)

      await install({ ...platform, directory: dir, fetchChecksum, downloadFile, strict: true })

      expect(fetchChecksum).not.toHaveBeenCalled()
      expect(downloadFile).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
    })
  })

  it('downloads with the shipped hash when the local binary mismatches', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, binaryName), 'stale')
      await writeFile(join(dir, 'checksums.json'), JSON.stringify({ [binaryName]: sha('fresh') }))
      const fetchChecksum = vi.fn()
      const downloadFile = vi.fn(async (_u, dest: string, checksum: string, cb: Callback) => {
        expect(checksum).toBe(sha('fresh'))
        await writeFile(dest, 'fresh')
        cb(null)
      })
      vi.spyOn(console, 'log').mockReturnValue(undefined)

      await install({ ...platform, directory: dir, fetchChecksum, downloadFile })

      expect(fetchChecksum).not.toHaveBeenCalled()
      expect(downloadFile).toHaveBeenCalledOnce()
      await expect(readFile(join(dir, binaryName), 'utf8')).resolves.toBe('fresh')
    })
  })

  it('falls back to the .sha256 fetch when checksums.json is missing', async () => {
    const fetchChecksum = vi.fn((_u, cb: Callback<string>) =>
      cb(null, `${sha('x')}  ${binaryName}\n`),
    )
    const downloadFile = vi.fn((_u, _d, _c, cb: Callback) => cb(null))
    vi.spyOn(console, 'log').mockReturnValue(undefined)
    await withDir((directory) =>
      install({ ...platform, directory, fetchChecksum, downloadFile }),
    )
    expect(fetchChecksum).toHaveBeenCalledOnce()
    expect(downloadFile).toHaveBeenCalledOnce()
  })

  it('loadShippedChecksum ignores missing, invalid and unlisted entries', async () => {
    await withDir(async (dir) => {
      expect(loadShippedChecksum(dir, binaryName)).toBeUndefined()
      await writeFile(join(dir, 'checksums.json'), '{not json')
      expect(loadShippedChecksum(dir, binaryName)).toBeUndefined()
      await writeFile(join(dir, 'checksums.json'), JSON.stringify({ [binaryName]: 'short' }))
      expect(loadShippedChecksum(dir, binaryName)).toBeUndefined()
      expect(loadShippedChecksum(dir, 'other.node')).toBeUndefined()
      const upper = sha('a').toUpperCase()
      expect(loadShippedChecksum(dir, binaryName, () => JSON.stringify({ [binaryName]: upper }))).toBe(
        upper.toLowerCase(),
      )
    })
  })
})

describe('LINGUA_RS_SKIP_DOWNLOAD', () => {
  it('exits immediately with one log line and beats strict mode', async () => {
    const run = vi.fn()
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined)
    await main({ env: { LINGUA_RS_SKIP_DOWNLOAD: '1', LINGUA_RS_STRICT_INSTALL: '1' }, run })
    expect(run).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()
    expect(process.exitCode).toBeUndefined()
  })

  it('treats unset, empty, 0 and false as off', () => {
    for (const value of [undefined, '', '0', 'false', ' FALSE ']) {
      expect(isSkipDownload({ LINGUA_RS_SKIP_DOWNLOAD: value })).toBe(false)
    }
    expect(isSkipDownload({ LINGUA_RS_SKIP_DOWNLOAD: 'true' })).toBe(true)
    expect(isSkipDownload()).toBe(false)
  })
})

describe('download time budget', () => {
  it('parses LINGUA_RS_DOWNLOAD_TIMEOUT_MS and defaults to 90s', () => {
    expect(downloadTimeoutMs({})).toBe(90_000)
    expect(downloadTimeoutMs({ LINGUA_RS_DOWNLOAD_TIMEOUT_MS: '5000' })).toBe(5000)
    for (const bad of ['abc', '0', '-1']) {
      expect(downloadTimeoutMs({ LINGUA_RS_DOWNLOAD_TIMEOUT_MS: bad })).toBe(90_000)
    }
    expect(downloadTimeoutMs()).toBe(90_000)
  })

  it('passes the timeout from main to install', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    await main({ env: { LINGUA_RS_DOWNLOAD_TIMEOUT_MS: '1234' }, run })
    expect(run).toHaveBeenCalledWith({ strict: false, timeoutMs: 1234 })
  })

  it('stops retrying once the next backoff would exceed the budget', async () => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const sleep = vi.fn()
    const clock = 0
    const operation = vi.fn(async () => {
      throw transient()
    })
    await expect(
      withRetry('op', operation, { sleep, random: () => 0, now: () => clock, deadline: 1500 }),
    ).rejects.toMatchObject({ code: 'EBUDGET', message: expect.stringContaining('HTTP 504') })
    // attempt 1 backoff is 1000ms (fits in 1500), attempt 2 backoff 2000ms does not.
    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('fails when the deadline has already passed', async () => {
    const operation = vi.fn()
    await expect(withRetry('op', operation, { now: () => 10, deadline: 10 })).rejects.toMatchObject({
      code: 'EBUDGET',
    })
    expect(operation).not.toHaveBeenCalled()
  })

  it('abandons an attempt that outlives the budget', async () => {
    const hang = () => new Promise<never>(() => undefined)
    await expect(withRetry('op', hang, { deadline: Date.now() + 20 })).rejects.toMatchObject({
      code: 'EBUDGET',
    })
  })

  it('returns the value when an attempt finishes inside the budget', async () => {
    await expect(withRetry('op', async () => 'ok', { deadline: Date.now() + 1000 })).resolves.toBe('ok')
  })

  it('non-strict install gives up with exit-0 semantics; strict throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    vi.spyOn(console, 'log').mockReturnValue(undefined)
    const downloadFile = vi.fn((_u, _d, _c, cb: Callback) => cb(transient()))
    const hashExistingFile = (_f: string, cb: Callback<string>) => cb(new Error('ENOENT'))
    const options = {
      ...platform,
      directory: '/nonexistent',
      checksums: () => sha('x'),
      hashExistingFile,
      downloadFile,
      timeoutMs: 1500,
      retry: { sleep: vi.fn(), random: () => 0, now: () => 0 },
    }
    await expect(install(options)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('total time budget exhausted'))
    await expect(install({ ...options, strict: true })).rejects.toMatchObject({ code: 'EBUDGET' })
  })

  it('exhausts the budget during the checksum fallback fetch', async () => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const fetchChecksum = vi.fn((_u, cb: Callback<string>) => cb(transient()))
    await expect(
      install({
        ...platform,
        directory: '/nonexistent',
        fetchChecksum,
        timeoutMs: 1500,
        strict: true,
        retry: { sleep: vi.fn(), random: () => 0, now: () => 0 },
      }),
    ).rejects.toMatchObject({ code: 'EBUDGET' })
  })
})
