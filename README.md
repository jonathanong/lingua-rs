# lingua-rs

[![CI](https://github.com/jonathanong/lingua-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathanong/lingua-rs/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jonathanong/lingua-rs/graph/badge.svg)](https://codecov.io/gh/jonathanong/lingua-rs)
[![npm](https://img.shields.io/npm/v/lingua-rs.svg)](https://www.npmjs.com/package/lingua-rs)

Language detection for Node.js — wraps the [`lingua`](https://crates.io/crates/lingua) crate via N-API, detecting 75 languages with high accuracy using pre-trained statistical models.

## Installation

```sh
npm install lingua-rs
```

### Native binary download

On supported platforms, the install script downloads the matching native binary from the GitHub
release for the package version and installs it only after its SHA-256 digest matches; the
replacement is atomic, so a failed verification does not overwrite an existing binary.

#### Offline-friendly install (shipped checksums)

The published npm package contains `checksums.json` (next to `postinstall.js`), a map of
`{ "<binaryName>": "<sha256>" }` for every supported platform, written by the release workflow before
`npm publish`. The install script reads the expected digest from it:

- If the binary already on disk (for example restored from a CI cache) matches, the script exits
  without any network call.
- Otherwise the binary is downloaded and verified against the shipped digest. No `.sha256` file is
  fetched at install time.
- If `checksums.json` is missing or has no valid entry for the platform (a local checkout or a git
  install), the script falls back to fetching `<binary>.sha256` from the release, as before.

Each binary fetch is cancelled after 30 seconds without progress.

#### Skipping the download

Set `LINGUA_RS_SKIP_DOWNLOAD=1` to make the install script log one line and exit 0 immediately, for
jobs that never load the addon. It takes precedence over `LINGUA_RS_STRICT_INSTALL`. Unset, empty,
`0` and `false` leave it off.

#### Download time budget

All network work, including every retry and backoff wait, shares one budget of 90 seconds, so an
outage cannot stall `npm install` for minutes. Override it with `LINGUA_RS_DOWNLOAD_TIMEOUT_MS`
(milliseconds; invalid or non-positive values use the default). When the budget runs out the install
gives up: it exits 0 in the default mode, or fails in strict mode.

#### Retries

Transient failures are retried, for both the binary download and the fallback checksum fetch, up to
7 attempts in total, within the time budget above. The waits between attempts are exponential with
jitter: about 1 s, 2 s, 4 s, 8 s, 16 s and 30 s, each plus up to 25%. Every retry logs one line with the attempt number, the reason and the delay.

- Retried: HTTP 5xx, 408 and 429; `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`
  and "socket hang up"; the 30-second timeouts; a response that closes before it completes; and a
  checksum mismatch after a download, because the body may have been truncated.
- `Retry-After` is honored on 429 and 503, as seconds or an HTTP date, and a single wait is capped
  at 30 seconds.
- Not retried: 404, 403 and other 4xx responses, an invalid checksum file, too many redirects, and
  an unsupported platform.

#### Strict install

The default install remains best-effort: after the retries, a failed or timed-out native download
leaves any existing binary in place, prints an actionable warning, and does not make `npm install`
fail. A consumer that must not ship without the native binary, such as a Docker image build, can
fail closed by setting `LINGUA_RS_STRICT_INSTALL` for the install:

```sh
LINGUA_RS_STRICT_INSTALL=1 pnpm install
```

In a Dockerfile, use `ENV LINGUA_RS_STRICT_INSTALL=1` before the install step. With the variable
set, the install script runs `install({ strict: true })`. If the binary still cannot be installed
(the retries are exhausted, a failure is not retryable, or the platform is unsupported), it prints
an error that names the variable and exits non-zero, so the package install fails. Use `1`; any
value other than unset, empty, `0` or `false` turns strict mode on, so a typo fails closed. Those
four values keep the best-effort default.

Strict mode only applies when the install script runs. It does nothing under `--ignore-scripts`,
or when the package manager does not allow `lingua-rs` to run its install script (for example
pnpm's build-script allowlist), so also check that the native binding loads after the install.

Release publishing is always strict: after the release checksums have been written to
`checksums.json` and the Linux x64 release asset uploaded, the release workflow runs `install({ strict: true })`, loads that downloaded addon,
verifies deterministic English detection, and removes the downloaded `.node` before publishing the
npm package.

## Usage

```js
import { detectLanguage, detectLanguageMany } from 'lingua-rs'

// Single text detection
const result = await detectLanguage(Buffer.from('This is clearly English text.'))
console.log(result.languages[0].iso6391)          // "en"
console.log(result.languages[0].iso6393)          // "eng"
console.log(result.languages[0].confidence)       // 0.9...
console.log(result.detector)                      // "lingua"
console.log(result.detectorModelVersion)          // "1.8.0"

// With options
const filtered = await detectLanguage(
  Buffer.from('Bonjour le monde.'),
  { minConfidence: 0.5 }
)

// Batch detection (processes all inputs in one libuv thread pool task)
const results = await detectLanguageMany([
  Buffer.from('The quick brown fox.'),
  Buffer.from('Bonjour le monde.'),
  Buffer.from('Hola mundo.'),
])
```

## API

### `detectLanguage(input: Buffer, options?: DetectOptions): Promise<LinguaDetectionResult>`

Detects the language(s) of a single UTF-8 encoded Buffer. Runs on the libuv thread pool — non-blocking.

### `detectLanguageMany(inputs: Buffer[], options?: DetectOptions): Promise<LinguaDetectionResult[]>`

Detects languages for multiple inputs in a single thread pool task. More efficient than calling `detectLanguage` in a loop.

### `DetectOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lowAccuracy` | `boolean` | `false` | Use the faster low-accuracy model |
| `minConfidence` | `number` | `0.0` | Filter out languages below this confidence threshold |

### `LinguaDetectionResult`

| Field | Type | Description |
|-------|------|-------------|
| `detector` | `string` | Always `"lingua"` |
| `detectorModelVersion` | `string` | Version of the `lingua` crate (e.g. `"1.8.0"`) |
| `languages` | `LanguageResult[]` | Candidates sorted by descending confidence |

### `LanguageResult`

| Field | Type | Description |
|-------|------|-------------|
| `iso6391` | `string` | ISO 639-1 two-letter code (e.g. `"en"`) |
| `iso6393` | `string` | ISO 639-3 three-letter code (e.g. `"eng"`) |
| `confidence` | `number` | Score in `[0.0, 1.0]` |

## Repository layout

```
crate/      Pure-Rust library (the language detection logic, no napi deps)
package/    N-API cdylib + Node.js package (published to npm as lingua-rs)
```

## License

MIT
