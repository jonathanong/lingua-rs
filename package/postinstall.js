#!/usr/bin/env node
// Downloads the platform-specific native binary from the GitHub release.
// Transient failures are retried (see retry.js). Installation remains
// best-effort: an existing binary is preserved until a verified replacement is
// ready, and npm installation succeeds on failure, unless LINGUA_RS_STRICT_INSTALL
// is set to 1 or true, which makes a failed install exit non-zero.
'use strict'

const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pipeline } = require('node:stream')

const { version } = require('./package.json')
const {
  CHECKSUM_MISMATCH_CODE,
  RESPONSE_CLOSED_CODE,
  errorMessage,
  withRetry,
} = require('./retry')

const MAX_REDIRECTS = 5
const MAX_CHECKSUM_BYTES = 1024
const REQUEST_TIMEOUT_MS = 30_000
const STRICT_INSTALL_ENV = 'LINGUA_RS_STRICT_INSTALL'
const STRICT_INSTALL_VALUES = new Set(['1', 'true'])
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

function timeoutError(phase, url, timeoutMs) {
  const error = new Error(`lingua-rs timed out after ${timeoutMs}ms waiting for ${phase} from ${url}`)
  error.code = 'ETIMEDOUT'
  error.phase = phase
  error.url = url
  error.timeoutMs = timeoutMs
  return error
}

// Carries the status and Retry-After header so the retry policy can classify
// the failure without parsing the message.
function httpError(res, url) {
  const error = new Error(`HTTP ${res.statusCode} fetching ${url}`)
  error.statusCode = res.statusCode
  error.retryAfter = res.headers['retry-after']
  return error
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function request(
  url,
  cb,
  {
    redirectCount = 0,
    get = https.get,
    preResponseTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyInactivityTimeoutMs = REQUEST_TIMEOUT_MS,
    state,
  } = {},
) {
  const done = once(cb)
  const deadline = state?.preResponseDeadline ?? Date.now() + preResponseTimeoutMs
  const controller = new AbortController()
  let requestObject
  let response
  let preResponseTimer
  let bodyTimer
  let responseDone = false
  let responseDelivered = false

  const clearPreResponseTimer = () => {
    if (preResponseTimer) clearTimeout(preResponseTimer)
    preResponseTimer = undefined
  }
  const clearBodyTimer = () => {
    if (bodyTimer) clearTimeout(bodyTimer)
    bodyTimer = undefined
  }
  const destroy = (error) => {
    if (response && !response.destroyed) response.destroy(error)
    if (requestObject && !requestObject.destroyed) requestObject.destroy(error)
    controller.abort(error)
  }
  const timeout = (phase, timeoutMs) => {
    const error = timeoutError(phase, url, timeoutMs)
    clearPreResponseTimer()
    clearBodyTimer()
    if (phase === 'pre-response' || !responseDelivered) done(error)
    destroy(error)
  }
  const resetBodyTimer = () => {
    clearBodyTimer()
    bodyTimer = setTimeout(() => timeout('body', bodyInactivityTimeoutMs), bodyInactivityTimeoutMs)
    if (bodyTimer.unref) bodyTimer.unref()
  }
  const monitorBody = (res) => {
    response = res
    responseDone = false
    resetBodyTimer()
    res.on('data', resetBodyTimer)
    res.once('end', () => {
      responseDone = true
      clearBodyTimer()
    })
    res.once('error', () => {
      responseDone = true
      clearBodyTimer()
    })
    res.once('aborted', () => {
      if (responseDone) return
      responseDone = true
      clearBodyTimer()
    })
    res.once('close', () => {
      responseDone = true
      clearBodyTimer()
    })
  }

  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    done(timeoutError('pre-response', url, preResponseTimeoutMs))
    return
  }
  preResponseTimer = setTimeout(() => timeout('pre-response', preResponseTimeoutMs), remaining)
  try {
    requestObject = get(url, { signal: controller.signal }, (res) => {
      clearPreResponseTimer()
      response = res

      if (res.statusCode === 301 || res.statusCode === 302) {
        res.on('error', ignoreRedirectDrainError)
        res.resume()
        res.destroy()
        const location = res.headers.location && new URL(res.headers.location, url).toString()
        if (!location) {
          done(new Error(`HTTP ${res.statusCode} missing Location header fetching ${url}`))
          return
        }
        if (redirectCount >= MAX_REDIRECTS) {
          done(new Error(`Too many redirects fetching ${location}`))
          return
        }
        request(location, done, {
          redirectCount: redirectCount + 1,
          get,
          preResponseTimeoutMs,
          bodyInactivityTimeoutMs,
          state: { preResponseDeadline: deadline },
        })
        return
      }
      if (res.statusCode !== 200) {
        res.on('error', ignoreRedirectDrainError)
        res.resume()
        res.destroy()
        done(httpError(res, url))
        return
      }
      monitorBody(res)
      responseDelivered = true
      done(null, res)
    }).on('error', (error) => {
      clearPreResponseTimer()
      if (!response) done(error)
    })
  } catch (error) {
    clearPreResponseTimer()
    done(error)
  }
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

function fetchText(
  url,
  cb,
  redirectCount = 0,
  get = https.get,
  {
    preResponseTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyInactivityTimeoutMs = REQUEST_TIMEOUT_MS,
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
  }, { redirectCount, get, preResponseTimeoutMs, bodyInactivityTimeoutMs })
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
          cb(
            hashError ||
              codedError(`Checksum mismatch downloading ${url}`, CHECKSUM_MISMATCH_CODE),
          )
          return
        }
        install()
      })
    })
  }, { get, preResponseTimeoutMs, bodyInactivityTimeoutMs })
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
  strict = false,
  retry = {},
} = {}) {
  const platformKey = `${platform}-${arch}`
  const binaryName = BINARY_MAP[platformKey]

  if (!binaryName) {
    console.warn(
      `[lingua-rs] unsupported platform ${platformKey} — language detection will fail at runtime`,
    )
    if (strict) throw new Error(`unsupported platform ${platformKey}`)
    return
  }

  const dest = path.join(directory, binaryName)
  const url = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
  const checksumUrl = `${url}.sha256`

  let expectedChecksum
  try {
    const contents = await withRetry(
      `fetching ${binaryName}.sha256`,
      () => callbackPromise((cb) => fetchChecksum(checksumUrl, cb)),
      retry,
    )
    expectedChecksum = parseChecksum(contents, binaryName)
  } catch (error) {
    console.warn(
      `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: ${errorMessage(error)}`,
    )
    if (strict) throw error
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
    await withRetry(
      `downloading ${binaryName}`,
      () => callbackPromise((cb) => downloadFile(url, dest, expectedChecksum, cb)),
      retry,
    )
  } catch (error) {
    console.warn(
      `[lingua-rs] failed to download ${binaryName}.\n` +
        `  ${errorMessage(error)}\n` +
        '  The existing binary, if any, was left unchanged.',
    )
    if (strict) throw error
    return
  }
  console.log(`[lingua-rs] installed ${binaryName}`)
}

// Best-effort by default. Setting LINGUA_RS_STRICT_INSTALL to 1 or true makes
// a failed install exit non-zero so the consumer's package install fails.
function isStrictInstall(env = process.env) {
  return STRICT_INSTALL_VALUES.has(String(env[STRICT_INSTALL_ENV] ?? '').trim().toLowerCase())
}

async function main({ env = process.env, run = install } = {}) {
  const strict = isStrictInstall(env)
  try {
    await run({ strict })
  } catch (error) {
    console.error(
      strict
        ? `[lingua-rs] install failed and ${STRICT_INSTALL_ENV} is set, so the install is failing: ${errorMessage(error)}`
        : `[lingua-rs] install failed unexpectedly: ${errorMessage(error)}`,
    )
    process.exitCode = 1
  }
}

if (require.main === module) void main()

module.exports = {
  download,
  fetchText,
  hashFile,
  install,
  isStrictInstall,
  main,
  parseChecksum,
  MAX_REDIRECTS,
}
