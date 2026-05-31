# lingua-rs

Language detection wrapping the [`lingua`](https://crates.io/crates/lingua) crate — detects 75 languages using pre-trained statistical models.

## Usage

```toml
[dependencies]
lingua-rs = "0.1"
```

```rust
use lingua_rs::{detect, DetectionOptions};

// Default: full-accuracy model, no confidence threshold
let opts = DetectionOptions::default();
let result = detect("This is clearly English text.", &opts);

println!("{}", result.languages[0].iso6391);    // "en"
println!("{}", result.languages[0].iso6393);    // "eng"
println!("{}", result.languages[0].confidence); // 0.9...
println!("{}", result.detector);                // "lingua"
println!("{}", result.detector_model_version);  // "1.8.0"
```

## API

### `detect(text: &str, opts: &DetectionOptions) -> DetectionResult`

Detects the language(s) of `text`. The underlying `LanguageDetector` is initialised lazily on first call and reused for all subsequent calls — initialisation is expensive (loads statistical models) so you pay that cost at most once per mode.

### `DetectionOptions`

```rust
pub struct DetectionOptions {
    /// Use the faster low-accuracy model. Defaults to `false`.
    pub low_accuracy: bool,
    /// Exclude languages with confidence below this value. Defaults to `0.0`.
    pub min_confidence: f64,
}
```

### `DetectionResult`

```rust
pub struct DetectionResult {
    pub detector: String,               // always "lingua"
    pub detector_model_version: String, // lingua crate version at compile time
    pub languages: Vec<LanguageResult>, // sorted by descending confidence
}

pub struct LanguageResult {
    pub iso6391: String,   // ISO 639-1 two-letter code, e.g. "en"
    pub iso6393: String,   // ISO 639-3 three-letter code, e.g. "eng"
    pub confidence: f64,   // [0.0, 1.0]
}
```

## License

MIT
