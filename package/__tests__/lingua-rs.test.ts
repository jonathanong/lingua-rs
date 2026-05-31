import { describe, it, expect } from 'vitest'
import { detectLanguage, detectLanguageMany } from '../index'

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf-8')
}

describe('detectLanguage', () => {
  it('detects English text', async () => {
    const result = await detectLanguage(
      buf('The quick brown fox jumps over the lazy dog. This is clearly English text.'),
    )
    expect(result.languages.length).toBeGreaterThan(0)
    expect(result.languages[0].iso6391).toBe('en')
    expect(result.languages[0].confidence).toBeGreaterThan(0)
  })

  it('detects French text', async () => {
    const result = await detectLanguage(
      buf('Bonjour le monde. La France est un beau pays avec une riche histoire et culture.'),
    )
    expect(result.languages.length).toBeGreaterThan(0)
    expect(result.languages[0].iso6391).toBe('fr')
  })

  it('detects Spanish text', async () => {
    const result = await detectLanguage(
      buf('Hola mundo. España es un país hermoso con una rica historia y cultura.'),
    )
    expect(result.languages.length).toBeGreaterThan(0)
    expect(result.languages[0].iso6391).toBe('es')
  })

  it('returns iso6391 and iso6393 codes for English', async () => {
    const result = await detectLanguage(
      buf('The quick brown fox jumps over the lazy dog. This is clearly English text.'),
    )
    const top = result.languages[0]
    expect(top.iso6391).toBe('en')
    expect(top.iso6393).toBe('eng')
    expect(top.confidence).toBeGreaterThan(0)
  })

  it('returns detector metadata', async () => {
    const result = await detectLanguage(buf('This is an English sentence.'))
    expect(result.detector).toBe('lingua')
    expect(result.detectorModelVersion).toMatch(/^\d+\.\d+/)
  })

  it('rejects invalid UTF-8 Buffer', async () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x00])
    await expect(detectLanguage(invalid)).rejects.toThrow()
  })

  it('handles empty string without throwing', async () => {
    const result = await detectLanguage(buf(''))
    expect(result.detector).toBe('lingua')
  })

  it('applies minConfidence option', async () => {
    const result = await detectLanguage(
      buf('The quick brown fox jumps over the lazy dog. This is clearly English text.'),
      { minConfidence: 0.5 },
    )
    for (const lang of result.languages) {
      expect(lang.confidence).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('uses low accuracy mode when requested', async () => {
    const result = await detectLanguage(
      buf('The quick brown fox jumps over the lazy dog. This is clearly English text.'),
      { lowAccuracy: true },
    )
    expect(result.languages.length).toBeGreaterThan(0)
    expect(result.languages[0].iso6391).toBe('en')
  })

  it('handles 50 parallel calls', async () => {
    const inputs = Array.from({ length: 50 }, (_, i) =>
      buf(`This is English sentence number ${i} for concurrency testing.`),
    )
    const results = await Promise.all(inputs.map(b => detectLanguage(b)))
    expect(results).toHaveLength(50)
    for (const r of results) {
      expect(r.languages[0].iso6391).toBe('en')
    }
  })
})

describe('detectLanguageMany', () => {
  it('processes multiple Buffer inputs', async () => {
    const inputs = [
      buf('The quick brown fox jumps over the lazy dog. This is clearly English.'),
      buf('Bonjour le monde. La France est un beau pays avec une riche histoire.'),
      buf('Hola mundo. España es un país hermoso con una rica historia.'),
    ]
    const results = await detectLanguageMany(inputs)
    expect(results).toHaveLength(3)
    expect(results[0].languages[0].iso6391).toBe('en')
    expect(results[1].languages[0].iso6391).toBe('fr')
    expect(results[2].languages[0].iso6391).toBe('es')
  })

  it('returns empty array for empty input', async () => {
    const results = await detectLanguageMany([])
    expect(results).toHaveLength(0)
  })

  it('rejects with indexed error for invalid UTF-8', async () => {
    const valid = buf('This is English text for testing purposes.')
    const invalid = Buffer.from([0xff, 0xfe])
    await expect(detectLanguageMany([valid, invalid, valid])).rejects.toThrow(
      /detectLanguageMany\[1\]/,
    )
  })

  it('applies shared options to all inputs', async () => {
    const inputs = [
      buf('The quick brown fox jumps over the lazy dog. This is clearly English.'),
      buf('Bonjour le monde. La France est un beau pays avec une riche histoire.'),
    ]
    const results = await detectLanguageMany(inputs, { minConfidence: 0.3 })
    for (const result of results) {
      for (const lang of result.languages) {
        expect(lang.confidence).toBeGreaterThanOrEqual(0.3)
      }
    }
  })

  it('each result has detector and detectorModelVersion', async () => {
    const results = await detectLanguageMany([buf('This is English text for testing purposes.')])
    expect(results[0].detector).toBe('lingua')
    expect(results[0].detectorModelVersion).toMatch(/^\d+\.\d+/)
  })
})
