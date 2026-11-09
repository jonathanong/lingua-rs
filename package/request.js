// HTTP request helper with redirect handling, pre-response and body-inactivity
// timeouts, and abort-signal support. Used by the install script.
'use strict'

const https = require('node:https')

const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 30_000
const ignoreRedirectDrainError = () => undefined

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
    signal,
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

  if (signal?.aborted) {
    done(signal.reason)
    return
  }
  signal?.addEventListener('abort', () => {
    clearPreResponseTimer()
    clearBodyTimer()
    done(signal.reason)
    destroy(signal.reason)
  }, { once: true })

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
          signal,
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

module.exports = { MAX_REDIRECTS, REQUEST_TIMEOUT_MS, codedError, httpError, once, request }
