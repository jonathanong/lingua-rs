// Checksum parsing, hashing, text fetching and verified binary downloads.
'use strict'

const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { pipeline } = require('node:stream')

const { CHECKSUM_MISMATCH_CODE, RESPONSE_CLOSED_CODE } = require('./retry')
const { REQUEST_TIMEOUT_MS, codedError, once, request } = require('./request')

const MAX_CHECKSUM_BYTES = 1024
const HEX_DIGITS = '0123456789abcdef'

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

function fetchText(
  url,
  cb,
  redirectCount = 0,
  get = https.get,
  {
    preResponseTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyInactivityTimeoutMs = REQUEST_TIMEOUT_MS,
    signal,
  } = {},
) {
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
    res.on('close', () => {
      if (!res.readableEnded) {
        done(codedError(`Response closed before completion fetching ${url}`, RESPONSE_CLOSED_CODE))
      }
    })
  }, { redirectCount, get, preResponseTimeoutMs, bodyInactivityTimeoutMs, signal })
}

function download(
  url,
  dest,
  cb,
  {
    get = https.get,
    expectedChecksum,
    preResponseTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyInactivityTimeoutMs = REQUEST_TIMEOUT_MS,
    signal,
  } = {},
) {
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
        if (signal?.aborted) {
          try { fs.unlinkSync(tmp) } catch {}
          cb(signal.reason)
          return
        }
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
        if (signal?.aborted) {
          try { fs.unlinkSync(tmp) } catch {}
          cb(signal.reason)
          return
        }
        if (hashError || actualChecksum !== expectedChecksum) {
          try { fs.unlinkSync(tmp) } catch {}
          cb(
            hashError ||
              codedError(`Checksum mismatch downloading ${url}`, CHECKSUM_MISMATCH_CODE),
          )
          return
        }
        install()
      })
    })
  }, { get, preResponseTimeoutMs, bodyInactivityTimeoutMs, signal })
}

module.exports = { download, fetchText, hashFile, parseChecksum }
