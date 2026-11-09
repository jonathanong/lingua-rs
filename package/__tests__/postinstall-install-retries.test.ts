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
    expect(fetchChecksum).toHaveBeenLastCalledWith(`${releaseUrl}.sha256`, expect.any(Function), expect.any(AbortSignal))
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]])
    expect(downloadFile).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      `[lingua-rs] fetching ${binaryName}.sha256: attempt 1 of 7 failed ` +
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
      expect.any(AbortSignal),
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

  it('gives up on the checksum after seven attempts: best-effort by default, fatal when strict', async () => {
    const warn = quiet()
    const fetchChecksum = vi.fn((_url, callback: Callback<string>) => callback(transient()))
    const options = { platform: 'darwin', arch: 'arm64', fetchChecksum, retry } as const

    await expect(install(options)).resolves.toBeUndefined()
    expect(fetchChecksum).toHaveBeenCalledTimes(7)
    expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000], [16_000], [30_000]])
    expect(warn).toHaveBeenLastCalledWith(
      `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: ` +
        'HTTP 500 fetching https://example.test/x',
    )

    fetchChecksum.mockClear()
    await expect(install({ ...options, strict: true })).rejects.toMatchObject({ statusCode: 500 })
    expect(fetchChecksum).toHaveBeenCalledTimes(7)
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
