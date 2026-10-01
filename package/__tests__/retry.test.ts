import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  CHECKSUM_MISMATCH_CODE,
  DEFAULT_MAX_ATTEMPTS,
  MAX_DELAY_MS,
  RESPONSE_CLOSED_CODE,
  errorMessage,
  isRetryable,
  parseRetryAfter,
  retryDelayMs,
  withRetry,
} = require('../retry') as {
  CHECKSUM_MISMATCH_CODE: string
  DEFAULT_MAX_ATTEMPTS: number
  MAX_DELAY_MS: number
  RESPONSE_CLOSED_CODE: string
  errorMessage: (error: unknown) => string
  isRetryable: (error: unknown) => boolean
  parseRetryAfter: (value: unknown, now: number) => number | undefined
  retryDelayMs: (
    error: Error & { statusCode?: number; retryAfter?: string },
    attempt: number,
    options?: { random?: () => number; now?: () => number },
  ) => number
  withRetry: <T>(
    label: string,
    operation: () => Promise<T>,
    options?: {
      maxAttempts?: number
      sleep?: (ms: number) => Promise<void>
      random?: () => number
      now?: () => number
    },
  ) => Promise<T>
}

function httpError(statusCode: number, retryAfter?: string): Error {
  return Object.assign(new Error(`HTTP ${statusCode} fetching https://example.test/x`), {
    statusCode,
    retryAfter,
  })
}

function codedError(code: string, message = `failure ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('isRetryable', () => {
  it.each([500, 502, 503, 504, 599, 408, 429])('retries HTTP %i', statusCode => {
    expect(isRetryable(httpError(statusCode))).toBe(true)
  })

  it.each([301, 400, 401, 403, 404, 410, 499, 600])('does not retry HTTP %i', statusCode => {
    expect(isRetryable(httpError(statusCode))).toBe(false)
  })

  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_STREAM_PREMATURE_CLOSE',
    CHECKSUM_MISMATCH_CODE,
    RESPONSE_CLOSED_CODE,
  ])('retries network error code %s', code => {
    expect(isRetryable(codedError(code))).toBe(true)
  })

  it('retries a socket hang up even without an error code', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true)
  })

  it('does not retry permanent failures', () => {
    expect(isRetryable(codedError('ENOTFOUND'))).toBe(false)
    expect(isRetryable(new Error('Invalid checksum for lingua_rs.test.node'))).toBe(false)
    expect(isRetryable(new Error('Too many redirects fetching https://example.test/x'))).toBe(false)
    expect(isRetryable(new Error('HTTP 301 missing Location header fetching https://x.test'))).toBe(
      false,
    )
  })

  it('does not retry values that are not errors', () => {
    expect(isRetryable('ECONNRESET')).toBe(false)
    expect(isRetryable({ statusCode: 500 })).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
  })

  it('classifies by status before code', () => {
    const error = Object.assign(httpError(404), { code: 'ECONNRESET' })
    expect(isRetryable(error)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('3', now)).toBe(3_000)
    expect(parseRetryAfter(' 0 ', now)).toBe(0)
  })

  it('parses an HTTP date relative to now', () => {
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:00:07 GMT', now)).toBe(7_000)
  })

  it('treats an HTTP date in the past as no wait', () => {
    expect(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('ignores missing and unparseable values', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
  })
})

describe('retryDelayMs', () => {
  it('doubles from one second', () => {
    const error = httpError(500)
    const delays = [1, 2, 3].map(attempt => retryDelayMs(error, attempt, { random: () => 0 }))
    expect(delays).toEqual([1_000, 2_000, 4_000])
  })

  it('adds up to 25% jitter', () => {
    const error = httpError(500)
    const almostOne = 0.999999
    const delays = [1, 2, 3].map(attempt =>
      retryDelayMs(error, attempt, { random: () => almostOne }),
    )
    expect(delays).toEqual([1_249, 2_499, 4_999])
  })

  it('uses Math.random and the clock by default', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(retryDelayMs(httpError(500), 1)).toBe(1_125)
    expect(retryDelayMs(httpError(429, '2'), 1)).toBe(2_000)
  })

  it.each([429, 503])('honors Retry-After seconds on HTTP %i', statusCode => {
    expect(retryDelayMs(httpError(statusCode, '10'), 1, { random: () => 0 })).toBe(10_000)
  })

  it('honors a Retry-After date on 503', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    const error = httpError(503, 'Thu, 01 Oct 2026 12:00:05 GMT')
    expect(retryDelayMs(error, 1, { random: () => 0, now: () => now })).toBe(5_000)
  })

  it('caps Retry-After', () => {
    expect(retryDelayMs(httpError(429, '3600'), 1, { random: () => 0 })).toBe(MAX_DELAY_MS)
  })

  it('keeps the backoff when Retry-After is shorter', () => {
    expect(retryDelayMs(httpError(503, '1'), 3, { random: () => 0 })).toBe(4_000)
  })

  it('ignores Retry-After on other statuses and invalid values', () => {
    expect(retryDelayMs(httpError(500, '10'), 1, { random: () => 0 })).toBe(1_000)
    expect(retryDelayMs(httpError(429, 'later'), 1, { random: () => 0 })).toBe(1_000)
  })
})

describe('withRetry', () => {
  const noJitter = () => 0

  it('returns the first success without sleeping or logging', async () => {
    const sleep = vi.fn(async () => undefined)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)

    await expect(withRetry('op', async () => 'value', { sleep })).resolves.toBe('value')

    expect(sleep).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('retries transient failures with backoff and logs one line per retry', async () => {
    const sleep = vi.fn(async () => undefined)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(codedError('ECONNRESET', 'read ECONNRESET'))
      .mockResolvedValue('value')

    await expect(withRetry('fetching x', operation, { sleep, random: noJitter })).resolves.toBe(
      'value',
    )

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]])
    expect(warn.mock.calls).toEqual([
      [
        '[lingua-rs] fetching x: attempt 1 of 4 failed ' +
          '(HTTP 500 fetching https://example.test/x); retrying in 1.0s',
      ],
      ['[lingua-rs] fetching x: attempt 2 of 4 failed (read ECONNRESET); retrying in 2.0s'],
    ])
    expect(warn.mock.calls.every(([line]) => !String(line).includes('\n'))).toBe(true)
  })

  it('logs the error code when the message is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(codedError('ECONNREFUSED', ''))
      .mockResolvedValue('value')

    await withRetry('op', operation, { sleep: async () => undefined, random: noJitter })

    expect(warn).toHaveBeenCalledWith(
      '[lingua-rs] op: attempt 1 of 4 failed (ECONNREFUSED); retrying in 1.0s',
    )
  })

  it('makes four attempts by default and rethrows the last error', async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(4)
    const sleep = vi.fn(async () => undefined)
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const failures = [500, 502, 503, 504].map(statusCode => httpError(statusCode))
    const operation = vi.fn(async () => {
      throw failures.shift()
    })

    await expect(withRetry('op', operation, { sleep, random: noJitter })).rejects.toMatchObject({
      statusCode: 504,
    })

    expect(operation).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000]])
  })

  it('honors a custom attempt limit', async () => {
    const sleep = vi.fn(async () => undefined)
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const operation = vi.fn(async () => {
      throw httpError(500)
    })

    await expect(withRetry('op', operation, { maxAttempts: 2, sleep })).rejects.toBeInstanceOf(
      Error,
    )

    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('does not retry permanent failures', async () => {
    const sleep = vi.fn(async () => undefined)
    const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const operation = vi.fn(async () => {
      throw httpError(404)
    })

    await expect(withRetry('op', operation, { sleep })).rejects.toMatchObject({ statusCode: 404 })

    expect(operation).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('waits on a ref-ed timer so a pending retry keeps the process alive', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockReturnValue(undefined)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue('value')

    const result = withRetry('op', operation, { random: noJitter })
    await vi.advanceTimersByTimeAsync(999)
    expect(operation).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toBe('value')
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000)
    expect(setTimeoutSpy.mock.results[0]?.value.hasRef()).toBe(true)
  })
})

describe('errorMessage', () => {
  it('uses the message of errors and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('falls back to the code, then the name, when the message is empty', () => {
    expect(errorMessage(codedError('ECONNREFUSED', ''))).toBe('ECONNREFUSED')
    expect(errorMessage(new TypeError(''))).toBe('TypeError')
  })
})
