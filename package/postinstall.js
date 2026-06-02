#!/usr/bin/env node
// Downloads the platform-specific native binary from the GitHub release.
// If the download fails, installation succeeds but language detection will
// throw at runtime (detector.mts handles this and lets jobs retry).
'use strict'

const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')

const { version } = require('./package.json')

const BINARY_MAP = {
  'darwin-arm64': 'lingua_rs.darwin-arm64.node',
  'darwin-x64': 'lingua_rs.darwin-x64.node',
  'linux-x64': 'lingua_rs.linux-x64-gnu.node',
  'linux-arm64': 'lingua_rs.linux-arm64-gnu.node',
  'win32-x64': 'lingua_rs.win32-x64-msvc.node',
}

const platformKey = `${process.platform}-${process.arch}`
const binaryName = BINARY_MAP[platformKey]

if (!binaryName) {
  console.warn(`[lingua-rs] unsupported platform ${platformKey} — language detection will fail at runtime`)
  process.exit(0)
}

const dest = path.join(__dirname, binaryName)

if (fs.existsSync(dest)) {
  // Already present — local build or re-install of same version.
  process.exit(0)
}

const url = `https://github.com/jonathanong/lingua-rs/releases/download/v${version}/${binaryName}`
console.log(`[lingua-rs] downloading ${binaryName} from GitHub release v${version}`)

function download(url, dest, cb) {
  https
    .get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, dest, cb)
        return
      }
      if (res.statusCode !== 200) {
        cb(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        return
      }
      const tmp = dest + '.tmp'
      const file = fs.createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => {
        file.close((err) => {
          if (err) {
            cb(err)
            return
          }
          try {
            fs.renameSync(tmp, dest)
          } catch (e) {
            cb(e)
            return
          }
          cb(null)
        })
      })
      file.on('error', (err) => {
        try { fs.unlinkSync(tmp) } catch {}
        cb(err)
      })
      res.on('error', (err) => {
        try { fs.unlinkSync(tmp) } catch {}
        cb(err)
      })
    })
    .on('error', cb)
}

download(url, dest, (err) => {
  if (err) {
    try { fs.unlinkSync(dest) } catch {}
    console.warn(
      `[lingua-rs] failed to download ${binaryName}: ${err.message}\n` +
        '  Language detection will fail at runtime until the binary is available.',
    )
    process.exit(0)
  }
  console.log(`[lingua-rs] installed ${binaryName}`)
})
