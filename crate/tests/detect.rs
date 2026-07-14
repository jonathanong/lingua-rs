use lingua_rs::{detect, DetectionOptions};

// ── Basic language detection ──────────────────────────────────────────────────

#[test]
fn detects_english() {
    let opts = DetectionOptions::default();
    let result = detect(
        "The quick brown fox jumps over the lazy dog. This is clearly English text.",
        &opts,
    );
    assert!(
        !result.languages.is_empty(),
        "expected at least one language"
    );
    assert_eq!(
        result.languages[0].iso6391, "en",
        "expected English as top language"
    );
    assert!(result.languages[0].confidence > 0.0);
}

#[test]
fn detects_french() {
    let opts = DetectionOptions::default();
    let result = detect(
        "Bonjour le monde. La France est un beau pays avec une riche histoire et culture.",
        &opts,
    );
    assert!(!result.languages.is_empty());
    assert_eq!(result.languages[0].iso6391, "fr", "expected French");
}

#[test]
fn detects_spanish() {
    let opts = DetectionOptions::default();
    let result = detect(
        "Hola mundo. España es un país hermoso con una rica historia y cultura.",
        &opts,
    );
    assert!(!result.languages.is_empty());
    assert_eq!(result.languages[0].iso6391, "es", "expected Spanish");
}

#[test]
fn detects_german() {
    let opts = DetectionOptions::default();
    let result = detect(
        "Guten Morgen. Deutschland ist ein schönes Land mit einer reichen Geschichte und Kultur.",
        &opts,
    );
    assert!(!result.languages.is_empty());
    assert_eq!(result.languages[0].iso6391, "de", "expected German");
}

// ── ISO codes ────────────────────────────────────────────────────────────────

#[test]
fn language_result_has_iso6391_and_iso6393() {
    let opts = DetectionOptions::default();
    let result = detect(
        "The quick brown fox jumps over the lazy dog. This is clearly English text.",
        &opts,
    );
    let top = &result.languages[0];
    assert_eq!(top.iso6391, "en");
    assert_eq!(top.iso6393, "eng");
}

// ── Confidence filtering ──────────────────────────────────────────────────────

#[test]
fn min_confidence_filters_low_confidence_languages() {
    let opts = DetectionOptions {
        min_confidence: 0.5,
        ..Default::default()
    };
    let result = detect(
        "The quick brown fox jumps over the lazy dog. This is clearly English text.",
        &opts,
    );
    for lang in &result.languages {
        assert!(
            lang.confidence >= 0.5,
            "language {} has confidence {} below threshold",
            lang.iso6391,
            lang.confidence
        );
    }
}

#[test]
fn min_confidence_one_returns_empty_or_top_only() {
    let opts = DetectionOptions {
        min_confidence: 1.0,
        ..Default::default()
    };
    let result = detect("The quick brown fox jumps over the lazy dog.", &opts);
    // At confidence=1.0 threshold, most languages will be filtered out.
    for lang in &result.languages {
        assert_eq!(
            lang.confidence, 1.0,
            "only perfect-confidence languages should remain"
        );
    }
}

// ── Edge cases ────────────────────────────────────────────────────────────────

#[test]
fn empty_string_returns_result() {
    let opts = DetectionOptions::default();
    let result = detect("", &opts);
    // Empty input should return a result without panicking; languages may be empty.
    assert_eq!(result.detector, "lingua");
}

#[test]
fn short_text_returns_result() {
    let opts = DetectionOptions::default();
    let result = detect("Hi", &opts);
    // Short text — result may have low-confidence candidates or none.
    assert_eq!(result.detector, "lingua");
}

#[test]
fn whitespace_only_returns_result() {
    let opts = DetectionOptions::default();
    let result = detect("   \t\n  ", &opts);
    assert_eq!(result.detector, "lingua");
}

// ── Metadata ─────────────────────────────────────────────────────────────────

#[test]
fn result_metadata_is_populated() {
    let opts = DetectionOptions::default();
    let result = detect("This is an English sentence.", &opts);
    assert_eq!(result.detector, "lingua");
    assert_eq!(result.detector_model_version, "1.8.0");
}

// ── Low accuracy mode ─────────────────────────────────────────────────────────

#[test]
fn low_accuracy_mode_detects_english() {
    let opts = DetectionOptions {
        low_accuracy: true,
        ..Default::default()
    };
    let result = detect(
        "The quick brown fox jumps over the lazy dog. This is clearly English text.",
        &opts,
    );
    assert!(!result.languages.is_empty());
    assert_eq!(result.languages[0].iso6391, "en");
}

#[test]
fn low_accuracy_mode_detects_french() {
    let opts = DetectionOptions {
        low_accuracy: true,
        ..Default::default()
    };
    let result = detect(
        "Bonjour le monde. La France est un beau pays avec une riche histoire.",
        &opts,
    );
    assert!(!result.languages.is_empty());
    assert_eq!(result.languages[0].iso6391, "fr");
}

// ── Batch equivalent ─────────────────────────────────────────────────────────

#[test]
fn detect_many_texts() {
    let texts = [
        "The quick brown fox jumps over the lazy dog.",
        "Bonjour le monde. La France est un beau pays.",
        "Hola mundo. España es un país hermoso.",
    ];
    let opts = DetectionOptions::default();
    let results: Vec<_> = texts.iter().map(|t| detect(t, &opts)).collect();

    assert_eq!(results.len(), 3);
    assert_eq!(results[0].languages[0].iso6391, "en");
    assert_eq!(results[1].languages[0].iso6391, "fr");
    assert_eq!(results[2].languages[0].iso6391, "es");
}
