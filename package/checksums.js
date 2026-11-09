// Reads the checksums.json shipped in the npm package by the release workflow:
// { "<binaryName>": "<sha256 hex>" }. Returns undefined when the file is absent
// or unusable (local development, git install) so the caller can fall back.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SHA256_HEX = /^[0-9a-f]{64}$/

function loadShippedChecksum(directory, binaryName, readFile = fs.readFileSync) {
  try {
    const parsed = JSON.parse(readFile(path.join(directory, 'checksums.json'), 'utf8'))
    const value = String(parsed?.[binaryName] ?? '').toLowerCase()
    return SHA256_HEX.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

module.exports = { loadShippedChecksum }
