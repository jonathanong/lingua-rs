#!/usr/bin/env node
// Downloads the platform-specific native binary from the GitHub release.
// Installation remains best-effort: an existing binary is preserved until a
// verified replacement is ready, and npm installation succeeds on failure.
'use strict'

const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pipeline } = require('node:stream')

const { version } = require('./package.json')

const MAX_REDIRECTS = 5
const MAX_CHECKSUM_BYTES = 1024
const ignoreRedirectDrainError = () => undefined

const BINARY_MAP = {
  'darwin-arm64': 'lingua_rs.darwin-arm64.node',
  'darwin-x64': 'lingua_rs.darwin-x64.node',
  'linux-x64': 'lingua_rs.linux-x64-gnu.node',
  'linux-arm64': 'lingua_rs.linux-arm64-gnu.node',
  'win32-x64': 'lingua_rs.win32-x64-msvc.node',
}

function hashFile(filename, cb) {
  const hash = crypto.createHash('sha256')
  const file = fs.createReadStream(filename)
  let checksum
  let finished = false
  const done = (err, value) => {
    if (finished) return
    finished = true
    cb(err, value)
  }
  file.on('error', (err) => done(err))
  file.on('data', (chunk) => hash.update(chunk))
  file.on('end', () => {
    checksum = hash.digest('hex')
  })
  file.on('close', () => {
    if (checksum) done(null, checksum)
  })
}

function parseChecksum(contents, binaryName) {
  if (typeof contents !== 'string') {
    throw new Error(`Invalid checksum for ${binaryName}`)
  }
  const match = /^([a-f\d]{64})[ \t]+\*?(.+)$/i.exec(contents.trim())
  if (!match || match[2] !== binaryName) {
    throw new Error(`Invalid checksum for ${binaryName}`)
  }
  return match[1].toLowerCase()
}

function fetchText(url, cb, redirectCount = 0, get = https.get) {
  get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      res.on('error', ignoreRedirectDrainError)
      res.resume()
      const location = res.headers.location && new URL(res.headers.location, url).toString()
      if (!location) {
        cb(new Error(`HTTP ${res.statusCode} missing Location header fetching ${url}`))
        return
      }
      if (redirectCount >= MAX_REDIRECTS) {
        cb(new Error(`Too many redirects fetching ${location}`))
        return
      }
      fetchText(location, cb, redirectCount + 1, get)
      return
    }
    if (res.statusCode !== 200) {
      res.on('error', ignoreRedirectDrainError)
      res.resume()
      cb(new Error(`HTTP ${res.statusCode} fetching ${url}`))
      return
    }

    let contents = ''
    let finished = false
    const done = (err, value) => {
      if (finished) return
      finished = true
      cb(err, value)
    }
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      contents += chunk
      if (contents.length > MAX_CHECKSUM_BYTES) {
        res.destroy(new Error(`Checksum response too large fetching ${url}`))
      }
    })
    res.on('error', (err) => done(err))
    res.on('end', () => done(null, contents))
  }).on('error', cb)
}

function download(url, dest, cb, redirectCount = 0, get = https.get, expectedChecksum) {
  get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      res.on('error', ignoreRedirectDrainError)
      res.resume()
      const location = res.headers.location && new URL(res.headers.location, url).toString()
      if (!location) {
        cb(new Error(`HTTP ${res.statusCode} missing Location header fetching ${url}`))
        return
      }
      if (redirectCount >= MAX_REDIRECTS) {
        cb(new Error(`Too many redirects fetching ${location}`))
        return
      }
      download(location, dest, cb, redirectCount + 1, get, expectedChecksum)
      return
    }
    if (res.statusCode !== 200) {
      cb(new Error(`HTTP ${res.statusCode} fetching ${url}`))
      return
    }
    const tmp = dest + '.tmp'
    const file = fs.createWriteStream(tmp)
    pipeline(res, file, (err) => {
      if (err) {
        try { fs.unlinkSync(tmp) } catch {}
        cb(err)
        return
      }
      const install = () => {
        try {
          fs.renameSync(tmp, dest)
        } catch (e) {
          try { fs.unlinkSync(tmp) } catch {}
          cb(e)
          return
        }
        cb(null)
      }

      if (!expectedChecksum) {
        install()
        return
      }
      hashFile(tmp, (hashError, actualChecksum) => {
        if (hashError || actualChecksum !== expectedChecksum) {
          try { fs.unlinkSync(tmp) } catch {}
          cb(hashError || new Error(`Checksum mismatch downloading ${url}`))
          return
        }
        install()
      })
    })
  }).on('error', cb)
}

function install({
  platform = process.platform,
  arch = process.arch,
  directory = __dirname,
  fetchChecksum = fetchText,
  hashExistingFile = hashFile,
  downloadFile = (url, dest, checksum, cb) => download(url, dest, cb, 0, https.get, checksum),
} = {}) {
  const platformKey = `${platform}-${arch}`
  const binaryName = BINARY_MAP[platformKey]

  if (!binaryName) {
    console.warn(
      `[lingua-rs] unsupported platform ${platformKey} — language detection will fail at runtime`,
    )
    return Promise.resolve()
  }

  const dest = path.join(directory, binaryName)
  const url = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
  const checksumUrl = `${url}.sha256`

  return new Promise((resolve) => {
    fetchChecksum(checksumUrl, (checksumError, contents) => {
      let expectedChecksum
      try {
        if (checksumError) throw checksumError
        expectedChecksum = parseChecksum(contents, binaryName)
      } catch (error) {
        console.warn(
          `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: ${error.message}`,
        )
        resolve()
        return
      }

      const downloadCurrentRelease = () => {
        console.log(`[lingua-rs] downloading ${binaryName} from GitHub release v${version}`)
        downloadFile(url, dest, expectedChecksum, (err) => {
          if (err) {
            console.warn(
              `[lingua-rs] failed to download ${binaryName}: ${err.message}\n` +
                '  The existing binary, if any, was left unchanged.',
            )
          } else {
            console.log(`[lingua-rs] installed ${binaryName}`)
          }
          resolve()
        })
      }

      hashExistingFile(dest, (hashError, actualChecksum) => {
        if (!hashError && actualChecksum === expectedChecksum) {
          console.log(`[lingua-rs] ${binaryName} is up to date`)
          resolve()
          return
        }
        downloadCurrentRelease()
      })
    })
  })
}

if (require.main === module) void install()

module.exports = { download, fetchText, hashFile, install, parseChecksum, MAX_REDIRECTS }
