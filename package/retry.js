// Retry policy for the install script's GitHub Releases requests.
// Transient failures (HTTP 5xx, 408 and 429, connection errors, timeouts,
// truncated bodies, and checksum mismatches) are retried with exponential
// backoff and jitter. Everything else (404, 403, other 4xx, invalid checksum
// files, redirect loops) fails immediately.
'use strict'

const DEFAULT_MAX_ATTEMPTS = 7
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
// Raised when the total retry budget runs out. Not retryable.
const BUDGET_EXHAUSTED_CODE = 'EBUDGET'
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
// are roughly 1 s, 2 s, 4 s, 8 s, 16 s and 30 s (the last capped), each plus
// up to 25% jitter, about 60 s in total across the default 7 attempts. Retry-After is
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

function budgetError(label, lastError) {
  const detail = lastError ? ` (last error: ${errorMessage(lastError)})` : ''
  const error = new Error(`${label}: total time budget exhausted${detail}`)
  error.code = BUDGET_EXHAUSTED_CODE
  return error
}

// Runs the operation but gives up when `remainingMs` elapses. The operation
// receives an AbortSignal that is aborted (with the budget error) on expiry so
// it can cancel its in-flight work.
function withDeadline(label, operation, remainingMs) {
  const controller = new AbortController()
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = budgetError(label)
      reject(error)
      controller.abort(error)
    }, remainingMs)
  })
  return Promise.race([operation(controller.signal), expired]).finally(() => clearTimeout(timer))
}

function startAttempt(label, operation, deadline, now) {
  const remaining = deadline === undefined ? Infinity : deadline - now()
  if (remaining <= 0) {
    throw budgetError(label)
  }
  return remaining === Infinity
    ? operation(new AbortController().signal)
    : withDeadline(label, operation, remaining)
}

// Returns the backoff before the next attempt, or throws when retrying is over.
function nextDelayMs(label, error, attempt, { maxAttempts, random, now, deadline }) {
  if (attempt >= maxAttempts || !isRetryable(error)) throw error
  const delayMs = retryDelayMs(error, attempt, { random, now })
  if (deadline !== undefined && delayMs >= deadline - now()) throw budgetError(label, error)
  return delayMs
}

// Turns a rejection into a value so the retry loop needs no try/catch.
async function settle(run) {
  try {
    return { value: await run() }
  } catch (error) {
    return { failed: true, error }
  }
}

// Some network errors (an AggregateError from a refused connection) have an
// empty message, so fall back to the code.
function errorMessage(error) {
  if (!(error instanceof Error)) return String(error)
  return error.message || error.code || error.name
}

// `deadline` is an absolute timestamp (ms) bounding the whole call, including
// every attempt and backoff. Pass the same value to several calls to share it.
async function withRetry(
  label,
  operation,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS, sleep = defaultSleep, random, now = Date.now, deadline } = {},
) {
  // The checks live in sync helpers: V8 reports bogus negative branch counts
  // for conditionals that follow an `await` inside a loop.
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await settle(() => startAttempt(label, operation, deadline, now))
    if (!outcome.failed) return outcome.value
    const delayMs = nextDelayMs(label, outcome.error, attempt, { maxAttempts, random, now, deadline })
    console.warn(
      `[lingua-rs] ${label}: attempt ${attempt} of ${maxAttempts} failed ` +
        `(${errorMessage(outcome.error)}); retrying in ${(delayMs / 1_000).toFixed(1)}s`,
    )
    await sleep(delayMs)
  }
}

module.exports = {
  BUDGET_EXHAUSTED_CODE,
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
