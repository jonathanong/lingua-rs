import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const { download, fetchText, install, parseChecksum, MAX_REDIRECTS } = require('../postinstall') as {
  download: (
    url: string,
    dest: string,
    callback: (error: Error | null) => void,
    options?: {
      get?: (url: string, callback: (response: FakeResponse) => void) => PassThrough
      expectedChecksum?: string
    },
  ) => void
  fetchText: (
    url: string,
    callback: (error: Error | null, contents?: string) => void,
    redirectCount?: number,
    get?: (url: string, callback: (response: FakeResponse) => void) => PassThrough,
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
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, { get })
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

  it('handles errors emitted while a redirect response drains', async () => {
    const redirect = new FakeResponse(302, 'https://example.test/binary')
    const failure = new FakeResponse(500)
    const [get, requestUrls] = redirectingGet([redirect, failure])

    await new Promise<Error | null>((resolve) => {
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, { get })
    })

    expect(() => redirect.emit('error', new Error('connection reset'))).not.toThrow()
    expect(requestUrls).toHaveBeenCalledTimes(2)
  })

  it('resolves a relative redirect location against the current URL', async () => {
    const redirect = new FakeResponse(302, '/binary')
    const failure = new FakeResponse(500)
    const [get, requestUrls] = redirectingGet([redirect, failure])

    await new Promise<Error | null>((resolve) => {
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, { get })
    })

    expect(requestUrls.mock.calls).toEqual([
      ['https://example.test/release'],
      ['https://example.test/binary'],
    ])
  })

  it('allows five redirects and rejects the sixth without another request', async () => {
    const redirects = Array.from(
      { length: MAX_REDIRECTS + 1 },
      (_, index) => new FakeResponse(302, `https://example.test/redirect-${index + 1}`),
    )
    const [get, requestUrls] = redirectingGet([...redirects])

    const error = await new Promise<Error | null>((resolve) => {
      download('https://example.test/release', '/tmp/lingua-rs-test', resolve, { get })
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
        download(
          'https://example.test/release',
          destination,
          resolve,
          { get, expectedChecksum: checksumOf(expectedArtifact) },
        )
      })
      success.end(expectedArtifact)

      await expect(downloadFinished).resolves.toBeNull()
      await expect(readFile(destination)).resolves.toEqual(expectedArtifact)
      expect(redirect.resumeSpy).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('destroys the response and removes the temporary file on stream errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, 'lingua_rs.test.node')
    const temporary = `${destination}.tmp`
    const response = new FakeResponse(200)
    const [get] = redirectingGet([response])
    const expectedError = new Error('connection reset')

    try {
      const downloadFinished = new Promise<Error | null>((resolve) => {
        download('https://example.test/binary', destination, resolve, { get })
      })
      response.write('partial artifact')
      response.emit('error', expectedError)

      await expect(downloadFinished).resolves.toBe(expectedError)
      await new Promise((resolve) => setImmediate(resolve))
      expect(response.destroyed).toBe(true)
      await expect(access(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a downloaded artifact with the wrong checksum without replacing the destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lingua-rs-postinstall-'))
    const destination = join(directory, binaryName)
    const previousArtifact = Buffer.from('previous-version')
    const response = new FakeResponse(200)
    const [get] = redirectingGet([response])

    try {
      await writeFile(destination, previousArtifact)
      const downloadFinished = new Promise<Error | null>((resolve) => {
        download(
          'https://example.test/binary',
          destination,
          resolve,
          { get, expectedChecksum: checksumOf('expected-version') },
        )
      })
      response.end('corrupt-version')

      await expect(downloadFinished).resolves.toMatchObject({
        message: 'Checksum mismatch downloading https://example.test/binary',
      })
      await expect(readFile(destination)).resolves.toEqual(previousArtifact)
      await expect(access(`${destination}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('postinstall checksum fetch', () => {
  it('fetches checksum text through a relative redirect', async () => {
    const expectedChecksum = checksumOf('artifact')
    const redirect = new FakeResponse(302, '/checksum')
    const success = new FakeResponse(200)
    const [get, requestUrls] = redirectingGet([redirect, success])
    const fetched = new Promise<string | undefined>((resolve, reject) => {
      fetchText(
        'https://example.test/release.sha256',
        (error, contents) => (error ? reject(error) : resolve(contents)),
        0,
        get,
      )
    })
    success.end(checksumFile(expectedChecksum))

    await expect(fetched).resolves.toBe(checksumFile(expectedChecksum))
    expect(requestUrls.mock.calls).toEqual([
      ['https://example.test/release.sha256'],
      ['https://example.test/checksum'],
    ])
  })

  it('requires a sha256sum-formatted checksum for the expected binary', () => {
    const expectedChecksum = checksumOf('artifact')

    expect(parseChecksum(checksumFile(expectedChecksum), binaryName)).toBe(expectedChecksum)
    expect(() => parseChecksum(`${expectedChecksum}  another.node\n`, binaryName)).toThrow(
      `Invalid checksum for ${binaryName}`,
    )
  })
})

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

      expect(fetchChecksum).toHaveBeenCalledWith(`${releaseUrl}.sha256`, expect.any(Function))
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
        `[lingua-rs] failed to fetch a valid checksum for ${binaryName}`,
      )
    } finally {
      warn.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
