// Environment switches read by the install script.
'use strict'

const STRICT_INSTALL_ENV = 'LINGUA_RS_STRICT_INSTALL'
const SKIP_DOWNLOAD_ENV = 'LINGUA_RS_SKIP_DOWNLOAD'
const DOWNLOAD_TIMEOUT_ENV = 'LINGUA_RS_DOWNLOAD_TIMEOUT_MS'
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 90_000
const OFF_VALUES = new Set(['', '0', 'false'])

const isOn = (env, name) => !OFF_VALUES.has(String(env[name] ?? '').trim().toLowerCase())

// Best-effort by default. Any LINGUA_RS_STRICT_INSTALL value other than unset,
// empty, 0 or false makes a failed install exit non-zero so the consumer's
// package install fails. An unexpected value fails closed rather than open.
const isStrictInstall = (env = process.env) => isOn(env, STRICT_INSTALL_ENV)

// Same value rules as strict mode.
const isSkipDownload = (env = process.env) => isOn(env, SKIP_DOWNLOAD_ENV)

// Total time budget for all network work (checksum fallback fetch, download and
// retries). Invalid or non-positive overrides fall back to the default.
function downloadTimeoutMs(env = process.env) {
  const value = Number(String(env[DOWNLOAD_TIMEOUT_ENV] ?? '').trim())
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DOWNLOAD_TIMEOUT_MS
}

module.exports = {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_ENV,
  SKIP_DOWNLOAD_ENV,
  STRICT_INSTALL_ENV,
  downloadTimeoutMs,
  isSkipDownload,
  isStrictInstall,
}
