#![deny(clippy::all)]

use lingua_rs::DetectionOptions as RustDetectionOptions;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

// ── Napi wrapper types ────────────────────────────────────────────────────────

#[napi(object)]
pub struct DetectOptions {
    /// When `true`, the low-accuracy (faster) model is used.
    pub low_accuracy: Option<bool>,
    /// Languages with a confidence score below this threshold are excluded.
    pub min_confidence: Option<f64>,
}

impl From<DetectOptions> for RustDetectionOptions {
    fn from(o: DetectOptions) -> Self {
        Self {
            low_accuracy: o.low_accuracy.unwrap_or(false),
            min_confidence: o.min_confidence.unwrap_or(0.0),
        }
    }
}

#[napi(object)]
pub struct LanguageResult {
    /// ISO 639-1 two-letter code (e.g. `"en"`).
    pub iso6391: String,
    /// ISO 639-3 three-letter code (e.g. `"eng"`).
    pub iso6393: String,
    /// Confidence score in the range `[0.0, 1.0]`.
    pub confidence: f64,
}

#[napi(object)]
pub struct LinguaDetectionResult {
    /// Detector name — always `"lingua"`.
    pub detector: String,
    /// Version of the `lingua` crate used at compile time.
    pub detector_model_version: String,
    /// Detected languages, sorted by descending confidence.
    pub languages: Vec<LanguageResult>,
}

// ── Conversion helpers ────────────────────────────────────────────────────────

fn convert_result(r: lingua_rs::DetectionResult) -> LinguaDetectionResult {
    LinguaDetectionResult {
        detector: r.detector,
        detector_model_version: r.detector_model_version,
        languages: r
            .languages
            .into_iter()
            .map(|l| LanguageResult {
                iso6391: l.iso6391,
                iso6393: l.iso6393,
                confidence: l.confidence,
            })
            .collect(),
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send + 'static>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

// ── detectLanguage ────────────────────────────────────────────────────────────

pub struct DetectTask {
    input: Buffer,
    options: RustDetectionOptions,
}

impl Task for DetectTask {
    type Output = LinguaDetectionResult;
    type JsValue = LinguaDetectionResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let text = std::str::from_utf8(&self.input)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            let result = lingua_rs::detect(text, &self.options);
            Ok(convert_result(result))
        }))
        .map_err(|payload| {
            napi::Error::from_reason(format!("lingua panic: {}", panic_message(&payload)))
        })?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<LinguaDetectionResult>")]
pub fn detect_language(input: Buffer, options: Option<DetectOptions>) -> AsyncTask<DetectTask> {
    let rust_options = options.map(RustDetectionOptions::from).unwrap_or_default();
    AsyncTask::new(DetectTask {
        input,
        options: rust_options,
    })
}

// ── detectLanguageMany ────────────────────────────────────────────────────────

pub struct DetectManyTask {
    inputs: Vec<Buffer>,
    options: RustDetectionOptions,
}

impl Task for DetectManyTask {
    type Output = Vec<LinguaDetectionResult>;
    type JsValue = Vec<LinguaDetectionResult>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.inputs
                .iter()
                .enumerate()
                .map(|(i, buf)| {
                    let text = std::str::from_utf8(buf).map_err(|e| {
                        napi::Error::from_reason(format!("detectLanguageMany[{i}]: {e}"))
                    })?;
                    let result = lingua_rs::detect(text, &self.options);
                    Ok(convert_result(result))
                })
                .collect()
        }))
        .map_err(|payload| {
            napi::Error::from_reason(format!("lingua panic: {}", panic_message(&payload)))
        })?
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<LinguaDetectionResult[]>")]
pub fn detect_language_many(
    inputs: Vec<Buffer>,
    options: Option<DetectOptions>,
) -> AsyncTask<DetectManyTask> {
    let rust_options = options.map(RustDetectionOptions::from).unwrap_or_default();
    AsyncTask::new(DetectManyTask {
        inputs,
        options: rust_options,
    })
}
