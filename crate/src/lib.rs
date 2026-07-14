//! `lingua-rs` — language detection wrapping the `lingua` crate.
//!
//! Detects 75 languages using pre-trained statistical models.
//!
//! ## Example
//!
//! ```rust
//! use lingua_rs::{detect, DetectionOptions};
//!
//! let opts = DetectionOptions::default();
//! let result = detect("This is clearly English text.", &opts);
//! assert_eq!(result.languages[0].iso6391, "en");
//! ```

use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};
use std::sync::OnceLock;

const LINGUA_VERSION: &str = env!("LINGUA_VERSION");

// ── Globals — built once, reused across all calls ────────────────────────────

static DETECTOR_FULL: OnceLock<LanguageDetector> = OnceLock::new();
static DETECTOR_LOW_ACC: OnceLock<LanguageDetector> = OnceLock::new();

fn full_detector() -> &'static LanguageDetector {
    DETECTOR_FULL.get_or_init(|| LanguageDetectorBuilder::from_all_languages().build())
}

fn low_acc_detector() -> &'static LanguageDetector {
    DETECTOR_LOW_ACC.get_or_init(|| {
        LanguageDetectorBuilder::from_all_languages()
            .with_low_accuracy_mode()
            .build()
    })
}

// ── Public types ──────────────────────────────────────────────────────────────

/// Options controlling detection behaviour.
#[derive(Debug, Clone)]
pub struct DetectionOptions {
    /// When `true` the low-accuracy (faster) model is used.
    pub low_accuracy: bool,
    /// Languages with a confidence score below this threshold are excluded from
    /// the result.  Defaults to `0.0` (all languages returned).
    pub min_confidence: f64,
}

impl Default for DetectionOptions {
    fn default() -> Self {
        Self {
            low_accuracy: false,
            min_confidence: 0.0,
        }
    }
}

/// A single language candidate with its ISO codes and confidence score.
#[derive(Debug, Clone)]
pub struct LanguageResult {
    /// ISO 639-1 two-letter code (e.g. `"en"`).
    pub iso6391: String,
    /// ISO 639-3 three-letter code (e.g. `"eng"`).
    pub iso6393: String,
    /// Confidence score in the range `[0.0, 1.0]`.
    pub confidence: f64,
}

/// Full detection result including metadata about the detector.
#[derive(Debug, Clone)]
pub struct DetectionResult {
    /// Detector name — always `"lingua"`.
    pub detector: String,
    /// Version of the `lingua` crate used at compile time.
    pub detector_model_version: String,
    /// Detected languages, sorted by descending confidence, filtered by
    /// [`DetectionOptions::min_confidence`].
    pub languages: Vec<LanguageResult>,
}

// ── Core detection function ───────────────────────────────────────────────────

/// Detect the language(s) of `text` using the given options.
///
/// The underlying [`LanguageDetector`] instances are lazily initialised on
/// first use and reused for all subsequent calls.
pub fn detect(text: &str, opts: &DetectionOptions) -> DetectionResult {
    let detector = if opts.low_accuracy {
        low_acc_detector()
    } else {
        full_detector()
    };

    let confidence_values = detector.compute_language_confidence_values(text);

    let languages = confidence_values
        .into_iter()
        .filter(|(_, conf)| *conf >= opts.min_confidence)
        .map(|(lang, conf)| language_to_result(lang, conf))
        .collect();

    DetectionResult {
        detector: "lingua".to_string(),
        detector_model_version: LINGUA_VERSION.to_string(),
        languages,
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn language_to_result(lang: Language, confidence: f64) -> LanguageResult {
    LanguageResult {
        iso6391: lang.iso_code_639_1().to_string(),
        iso6393: lang.iso_code_639_3().to_string(),
        confidence,
    }
}
