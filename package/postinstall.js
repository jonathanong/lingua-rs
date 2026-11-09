#!/usr/bin/env node
// Downloads the platform-specific native binary from the GitHub release.
// Transient failures are retried (see retry.js). Installation remains
// best-effort: an existing binary is preserved until a verified replacement is
// ready, and npm installation succeeds on failure, unless LINGUA_RS_STRICT_INSTALL
// is set (for example to 1), which makes a failed install exit non-zero.
'use strict'

const path = require('node:path')

const { version } = require('./package.json')
const { errorMessage, withRetry } = require('./retry')
const { loadShippedChecksum } = require('./checksums')
const { MAX_REDIRECTS } = require('./request')
const { download, fetchText, hashFile, parseChecksum } = require('./transfer')
const {
  SKIP_DOWNLOAD_ENV,
  STRICT_INSTALL_ENV,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadTimeoutMs,
  isSkipDownload,
  isStrictInstall,
} = require('./install-env')

const BINARY_MAP = {
  'darwin-arm64': 'lingua_rs.darwin-arm64.node',
  'darwin-x64': 'lingua_rs.darwin-x64.node',
  'linux-x64': 'lingua_rs.linux-x64-gnu.node',
  'linux-arm64': 'lingua_rs.linux-arm64-gnu.node',
  'win32-x64': 'lingua_rs.win32-x64-msvc.node',
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
  fetchChecksum = (url, cb, signal) => fetchText(url, cb, 0, undefined, { signal }),
  hashExistingFile = hashFile,
  downloadFile = (url, dest, checksum, cb, signal) =>
    download(url, dest, cb, { expectedChecksum: checksum, signal }),
  strict = false,
  retry = {},
  checksums = loadShippedChecksum,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
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
  // Prefer the checksum shipped in the npm package: no network is needed to
  // recognise an up-to-date binary. Without checksums.json (local development,
  // git install) fall back to fetching the release's .sha256 file.
  let expectedChecksum = checksums(directory, binaryName)
  const budget = { ...retry, deadline: (retry.now ?? Date.now)() + timeoutMs }

  if (!expectedChecksum) {
    try {
      const contents = await withRetry(
        `fetching ${binaryName}.sha256`,
        (signal) => callbackPromise((cb) => fetchChecksum(`${url}.sha256`, cb, signal)),
        budget,
      )
      expectedChecksum = parseChecksum(contents, binaryName)
    } catch (error) {
      console.warn(
        `[lingua-rs] failed to fetch a valid checksum for ${binaryName}: ${errorMessage(error)}`,
      )
      if (strict) throw error
      return
    }
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
      (signal) => callbackPromise((cb) => downloadFile(url, dest, expectedChecksum, cb, signal)),
      budget,
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

async function main({ env = process.env, run = install } = {}) {
  // Skip wins over strict: nothing is attempted, so nothing can fail.
  if (isSkipDownload(env)) {
    console.log(`[lingua-rs] ${SKIP_DOWNLOAD_ENV} is set, skipping native binary install`)
    return
  }
  const strict = isStrictInstall(env)
  try {
    await run({ strict, timeoutMs: downloadTimeoutMs(env) })
  } catch (error) {
    console.error(
      strict
        ? `[lingua-rs] install failed and ${STRICT_INSTALL_ENV} is set, so the install is failing: ${errorMessage(error)}`
        : `[lingua-rs] install failed unexpectedly: ${errorMessage(error)}`,
    )
    process.exitCode = 1
  }
}

// CLI entry point: only reachable when run as `node postinstall.js`, which the
// spawnSync tests do in a child process that the coverage tool cannot see.
/* v8 ignore next */
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
