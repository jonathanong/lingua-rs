// Retry policy for the install script's GitHub Releases requests.
// Transient failures (HTTP 5xx, 408 and 429, connection errors, timeouts,
// truncated bodies, and checksum mismatches) are retried with exponential
// backoff and jitter. Everything else (404, 403, other 4xx, invalid checksum
// files, redirect loops) fails immediately.
'use strict'

const DEFAULT_MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 1_000
const JITTER_RATIO = 0.25
const MAX_DELAY_MS = 30_000

// Error codes the install script assigns to its own failures.
const CHECKSUM_MISMATCH_CODE = 'ECHECKSUM'
const RESPONSE_CLOSED_CODE = 'ERESPONSE_CLOSED'

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  // A streamed binary body that ends early (the download path's equivalent of
  // RESPONSE_CLOSED_CODE).
  'ERR_STREAM_PREMATURE_CLOSE',
  CHECKSUM_MISMATCH_CODE,
  RESPONSE_CLOSED_CODE,
])
const SOCKET_HANG_UP = /socket hang up/i

function isRetryable(error) {
  if (!(error instanceof Error)) return false
  if (typeof error.statusCode === 'number') {
    return (
      (error.statusCode >= 500 && error.statusCode <= 599) ||
      error.statusCode === 408 ||
      error.statusCode === 429
    )
  }
  return RETRYABLE_CODES.has(error.code) || SOCKET_HANG_UP.test(error.message)
}

// Retry-After is either delta-seconds or an HTTP date. Returns milliseconds,
// or undefined when the value is missing or unparseable.
function parseRetryAfter(value, now) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

// `attempt` is the 1-based number of the attempt that just failed: the delays
// are roughly 1 s, 2 s and 4 s, each plus up to 25% jitter. Retry-After is
// honored on 429 and 503 and the result never exceeds MAX_DELAY_MS.
function retryDelayMs(error, attempt, { random = Math.random, now = Date.now } = {}) {
  const exponential = BASE_DELAY_MS * 2 ** (attempt - 1)
  const backoff = exponential + Math.floor(random() * exponential * JITTER_RATIO)
  const honorsRetryAfter = error.statusCode === 429 || error.statusCode === 503
  const retryAfter = honorsRetryAfter ? parseRetryAfter(error.retryAfter, now()) : undefined
  return Math.min(MAX_DELAY_MS, Math.max(backoff, retryAfter ?? 0))
}

// Not unref'd: while backing off nothing else keeps the event loop alive, and
// an unref'd timer would let the install script exit successfully mid-retry.
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function withRetry(
  label,
  operation,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS, sleep = defaultSleep, random, now } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error
      const delayMs = retryDelayMs(error, attempt, { random, now })
      console.warn(
        `[lingua-rs] ${label}: attempt ${attempt} of ${maxAttempts} failed ` +
          `(${errorMessage(error)}); retrying in ${(delayMs / 1_000).toFixed(1)}s`,
      )
      await sleep(delayMs)
    }
  }
}

// Some network errors (an AggregateError from a refused connection) have an
// empty message, so fall back to the code.
function errorMessage(error) {
  if (!(error instanceof Error)) return String(error)
  return error.message || error.code || error.name
}

module.exports = {
  CHECKSUM_MISMATCH_CODE,
  DEFAULT_MAX_ATTEMPTS,
  MAX_DELAY_MS,
  RESPONSE_CLOSED_CODE,
  errorMessage,
  isRetryable,
  parseRetryAfter,
  retryDelayMs,
  withRetry,
}
