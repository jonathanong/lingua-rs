# lingua-rs

[![CI](https://github.com/jonathanong/lingua-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathanong/lingua-rs/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jonathanong/lingua-rs/graph/badge.svg)](https://codecov.io/gh/jonathanong/lingua-rs)
[![npm](https://img.shields.io/npm/v/lingua-rs.svg)](https://www.npmjs.com/package/lingua-rs)

Language detection for Node.js — wraps the [`lingua`](https://crates.io/crates/lingua) crate via N-API, detecting 75 languages with high accuracy using pre-trained statistical models.

## Installation

```sh
npm install lingua-rs
```

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
