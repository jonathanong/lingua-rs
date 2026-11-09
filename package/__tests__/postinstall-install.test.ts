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

describe('postinstall installation', () => {
  it('skips the binary download when the installed checksum matches', async () => {
    const expectedChecksum = checksumOf('current-version')
    const fetchChecksum = vi.fn((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const hashExistingFile = vi.fn((_filename, callback) => callback(null, expectedChecksum))
    const downloadFile = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await install({
        platform: 'darwin',
        arch: 'arm64',
        fetchChecksum,
        hashExistingFile,
        downloadFile,
      })

      expect(fetchChecksum).toHaveBeenCalledWith(`${releaseUrl}.sha256`, expect.any(Function), expect.any(AbortSignal))
      expect(downloadFile).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(`[lingua-rs] ${binaryName} is up to date`)
    } finally {
      log.mockRestore()
    }
  })

  it('replaces a stale binary with the current release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, binaryName)
    const previousArtifact = Buffer.from('previous-version')
    const currentArtifact = Buffer.from('current-version')
    const expectedChecksum = checksumOf(currentArtifact)
    const fetchChecksum = vi.fn((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const downloadFile = vi.fn(async (_url, dest, checksum, callback) => {
      expect(checksum).toBe(expectedChecksum)
      await writeFile(dest, currentArtifact)
      callback(null)
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await writeFile(destination, previousArtifact)

      await install({ platform: 'darwin', arch: 'arm64', directory, fetchChecksum, downloadFile })

      expect(downloadFile).toHaveBeenCalledWith(
        releaseUrl,
        destination,
        expectedChecksum,
        expect.any(Function),
        expect.any(AbortSignal),
      )
      await expect(readFile(destination)).resolves.toEqual(currentArtifact)
    } finally {
      log.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('downloads the current release when the binary is missing', async () => {
    const expectedChecksum = checksumOf('current-version')
    const fetchChecksum = vi.fn((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const hashExistingFile = vi.fn((_filename, callback) => callback(new Error('ENOENT')))
    const downloadFile = vi.fn((_url, _dest, _checksum, callback) => callback(null))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await install({
        platform: 'darwin',
        arch: 'arm64',
        fetchChecksum,
        hashExistingFile,
        downloadFile,
      })

      expect(downloadFile).toHaveBeenCalledWith(
        releaseUrl,
        expect.stringMatching(binaryName),
        expectedChecksum,
        expect.any(Function),
        expect.any(AbortSignal),
      )
    } finally {
      log.mockRestore()
    }
  })

  it('leaves an existing binary unchanged when checksum lookup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, binaryName)
    const previousArtifact = Buffer.from('previous-version')
    const fetchChecksum = vi.fn((_url, callback) => callback(new Error('network unavailable')))
    const downloadFile = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await writeFile(destination, previousArtifact)

      await install({ platform: 'darwin', arch: 'arm64', directory, fetchChecksum, downloadFile })

      expect(downloadFile).not.toHaveBeenCalled()
      await expect(readFile(destination)).resolves.toEqual(previousArtifact)
      expect(warn).toHaveBeenCalledWith(
        `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: network unavailable`,
      )
    } finally {
      warn.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rethrows the exact checksum error in strict mode', async () => {
    const error = new Error('checksum service unavailable')
    const fetchChecksum = vi.fn((_url, callback) => callback(error))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(
        install({ platform: 'darwin', arch: 'arm64', fetchChecksum, strict: true }),
      ).rejects.toBe(error)
      expect(warn).toHaveBeenCalledWith(
        `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: checksum service unavailable`,
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('reports download failures and rethrows them in strict mode', async () => {
    const expectedChecksum = checksumOf('current-version')
    const error = new Error('binary response timed out')
    const fetchChecksum = vi.fn((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const hashExistingFile = vi.fn((_filename, callback) => callback(new Error('ENOENT')))
    const downloadFile = vi.fn((_url, _dest, _checksum, callback) => callback(error))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(
        install({
          platform: 'darwin',
          arch: 'arm64',
          fetchChecksum,
          hashExistingFile,
          downloadFile,
          strict: true,
        }),
      ).rejects.toBe(error)
      expect(warn).toHaveBeenCalledWith(
        `[lingua-rs] failed to download ${binaryName}.\n` +
          '  binary response timed out\n' +
          '  The existing binary, if any, was left unchanged.',
      )
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })

  it('reports download failures without rejecting by default', async () => {
    const expectedChecksum = checksumOf('current-version')
    const error = new Error('binary response timed out')
    const fetchChecksum = vi.fn((_url, callback) => callback(null, checksumFile(expectedChecksum)))
    const hashExistingFile = vi.fn((_filename, callback) => callback(new Error('ENOENT')))
    const downloadFile = vi.fn((_url, _dest, _checksum, callback) => callback(error))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(
        install({
          platform: 'darwin',
          arch: 'arm64',
          fetchChecksum,
          hashExistingFile,
          downloadFile,
        }),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        `[lingua-rs] failed to download ${binaryName}.\n` +
          '  binary response timed out\n' +
          '  The existing binary, if any, was left unchanged.',
      )
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
