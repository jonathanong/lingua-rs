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
const HEX_DIGITS = '0123456789abcdef'
const ignoreRedirectDrainError = () => undefined

const BINARY_MAP = {
  'darwin-arm64': 'lingua_rs.darwin-arm64.node',
  'darwin-x64': 'lingua_rs.darwin-x64.node',
  'linux-x64': 'lingua_rs.linux-x64-gnu.node',
  'linux-arm64': 'lingua_rs.linux-arm64-gnu.node',
  'win32-x64': 'lingua_rs.win32-x64-msvc.node',
}

function once(cb) {
  let finished = false
  return (err, value) => {
    if (finished) return
    finished = true
    cb(err, value)
  }
}

function request(url, cb, { redirectCount = 0, get = https.get } = {}) {
  const done = once(cb)
  get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      res.on('error', ignoreRedirectDrainError)
      res.resume()
      const location = res.headers.location && new URL(res.headers.location, url).toString()
      if (!location) {
        done(new Error(`HTTP ${res.statusCode} missing Location header fetching ${url}`))
        return
      }
      if (redirectCount >= MAX_REDIRECTS) {
        done(new Error(`Too many redirects fetching ${location}`))
        return
      }
      request(location, done, { redirectCount: redirectCount + 1, get })
      return
    }
    if (res.statusCode !== 200) {
      res.on('error', ignoreRedirectDrainError)
      res.resume()
      done(new Error(`HTTP ${res.statusCode} fetching ${url}`))
      return
    }
    done(null, res)
  }).on('error', done)
}

function hashFile(filename, cb) {
  const done = once(cb)
  const hash = crypto.createHash('sha256')
  const file = fs.createReadStream(filename)
  let checksum
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
    throw new TypeError(`Invalid checksum for ${binaryName}`)
  }
  const line = contents.trim()
  const checksum = line.slice(0, 64).toLowerCase()
  const separator = line.slice(64, 66)
  const filename = line.slice(66)
  const checksumIsHex =
    checksum.length === 64 && [...checksum].every((character) => HEX_DIGITS.includes(character))
  if (!checksumIsHex || separator !== '  ' || filename !== binaryName) {
    throw new Error(`Invalid checksum for ${binaryName}`)
  }
  return checksum
}

function fetchText(url, cb, redirectCount = 0, get = https.get) {
  request(url, (requestError, res) => {
    if (requestError) {
      cb(requestError)
      return
    }

    let contents = ''
    const done = once(cb)
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      contents += chunk
      if (contents.length > MAX_CHECKSUM_BYTES) {
        res.destroy(new Error(`Checksum response too large fetching ${url}`))
      }
    })
    res.on('error', (err) => done(err))
    res.on('end', () => done(null, contents))
  }, { redirectCount, get })
}

function download(url, dest, cb, { get = https.get, expectedChecksum } = {}) {
  request(url, (requestError, res) => {
    if (requestError) {
      cb(requestError)
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
  }, { get })
}

function callbackPromise(run) {
  return new Promise((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value)))
  })
}

async function install({
  platform = process.platform,
  arch = process.arch,
  directory = __dirname,
  fetchChecksum = fetchText,
  hashExistingFile = hashFile,
  downloadFile = (url, dest, checksum, cb) =>
    download(url, dest, cb, { expectedChecksum: checksum }),
} = {}) {
  const platformKey = `${platform}-${arch}`
  const binaryName = BINARY_MAP[platformKey]

  if (!binaryName) {
    console.warn(
      `[lingua-rs] unsupported platform ${platformKey} — language detection will fail at runtime`,
    )
    return
  }

  const dest = path.join(directory, binaryName)
  const url = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
  const checksumUrl = `${url}.sha256`

  let expectedChecksum
  try {
    const contents = await callbackPromise((cb) => fetchChecksum(checksumUrl, cb))
    expectedChecksum = parseChecksum(contents, binaryName)
  } catch {
    console.warn(`[lingua-rs] failed to fetch a valid checksum for ${binaryName}`)
    return
  }

  let actualChecksum
  try {
    actualChecksum = await callbackPromise((cb) => hashExistingFile(dest, cb))
  } catch {}
  if (actualChecksum === expectedChecksum) {
    console.log(`[lingua-rs] ${binaryName} is up to date`)
    return
  }

  console.log(`[lingua-rs] downloading ${binaryName} from GitHub release v${version}`)
  try {
    await callbackPromise((cb) => downloadFile(url, dest, expectedChecksum, cb))
  } catch {
    console.warn(
      `[lingua-rs] failed to download ${binaryName}.\n` +
        '  The existing binary, if any, was left unchanged.',
    )
    return
  }
  console.log(`[lingua-rs] installed ${binaryName}`)
}

if (require.main === module) void install()

module.exports = { download, fetchText, hashFile, install, parseChecksum, MAX_REDIRECTS }
