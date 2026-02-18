/**
 * Smoke tests for kaikki.ts parsing helpers.
 *
 * The helpers (mapPos, extractReading, extractDefinitions, parseEntry) are not
 * exported from kaikki.ts, so we inline minimal copies of the logic here and
 * test against the same contracts. If the module is later refactored to export
 * them, these tests can import directly.
 */

import { describe, test, expect } from 'bun:test'

// ============================================================================
// Inline copies of pure helpers (mirrors kaikki.ts logic)
// ============================================================================

function katakanaToHiragana(text: string): string {
  return text.replace(/[\u30A0-\u30FF]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  )
}

const INCLUDED_POS = new Set([
  'noun', 'verb', 'adj', 'adv', 'intj', 'pron', 'conj',
  'particle', 'counter', 'prefix', 'suffix', 'affix', 'phrase', 'proverb', 'num',
])

const SKIP_SENSE_TAGS = new Set(['alt-of', 'form-of', 'romanization', 'Rōmaji'])

function mapPos(pos: string): string {
  const mapping: Record<string, string> = {
    noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb',
    intj: 'interjection', pron: 'pronoun', conj: 'conjunction',
    particle: 'particle', counter: 'counter', prefix: 'prefix',
    suffix: 'suffix', affix: 'affix', phrase: 'expression',
    proverb: 'expression', num: 'numeral',
  }
  return mapping[pos] || pos
}

interface WiktEntry {
  word: string
  pos: string
  lang_code: string
  forms?: { form: string; tags?: string[]; ruby?: [string, string][] }[]
  senses?: { glosses?: string[]; raw_glosses?: string[]; tags?: string[] }[]
  sounds?: { other?: string }[]
}

function extractReading(entry: WiktEntry): string | null {
  if (entry.forms) {
    for (const form of entry.forms) {
      if (form.ruby && form.ruby.length > 0) {
        const reading = form.ruby.map(([_, kana]) => kana).join('')
        if (reading && /[\u3040-\u309F]/.test(reading)) return reading
      }
      if (form.tags?.includes('romanization')) continue
      if (form.form && /^[\u3040-\u309F]+$/.test(form.form)) return form.form
      if (form.form && /^[\u30A0-\u30FF]+$/.test(form.form)) return katakanaToHiragana(form.form)
    }
  }
  if (entry.sounds) {
    for (const sound of entry.sounds) {
      if (sound.other && /^[\u30A0-\u30FF]+$/.test(sound.other)) return katakanaToHiragana(sound.other)
    }
  }
  if (/^[\u3040-\u309F]+$/.test(entry.word)) return entry.word
  if (/^[\u30A0-\u30FF]+$/.test(entry.word)) return katakanaToHiragana(entry.word)
  return null
}

function extractDefinitions(entry: WiktEntry): string[] {
  const defs: string[] = []
  const seen = new Set<string>()
  if (!entry.senses) return defs
  for (const sense of entry.senses) {
    if (sense.tags?.some((t) => SKIP_SENSE_TAGS.has(t))) continue
    for (const gloss of (sense.glosses ?? sense.raw_glosses ?? [])) {
      const cleaned = gloss.replace(/\s+/g, ' ').trim()
      if (!cleaned) continue
      const norm = cleaned.toLowerCase()
      if (seen.has(norm)) continue
      seen.add(norm)
      defs.push(cleaned)
    }
  }
  return defs
}

// ============================================================================
// Tests
// ============================================================================

describe('POS mapping', () => {
  test('maps kaikki POS to internal values', () => {
    expect(mapPos('noun')).toBe('noun')
    expect(mapPos('adj')).toBe('adjective')
    expect(mapPos('phrase')).toBe('expression')
    expect(mapPos('proverb')).toBe('expression')
    expect(mapPos('num')).toBe('numeral')
  })

  test('unknown POS passed through', () => {
    expect(mapPos('determiner')).toBe('determiner')
  })
})

describe('extractReading', () => {
  test('extracts reading from ruby annotation', () => {
    const entry: WiktEntry = {
      word: '食べる', pos: 'verb', lang_code: 'ja',
      forms: [{ form: '食べる', ruby: [['食', 'た'], ['べる', 'べる']] }],
    }
    expect(extractReading(entry)).toBe('たべる')
  })

  test('extracts hiragana form', () => {
    const entry: WiktEntry = {
      word: '食べる', pos: 'verb', lang_code: 'ja',
      forms: [{ form: 'たべる' }],
    }
    expect(extractReading(entry)).toBe('たべる')
  })

  test('converts katakana form to hiragana', () => {
    const entry: WiktEntry = {
      word: 'ネコ', pos: 'noun', lang_code: 'ja',
      forms: [{ form: 'ネコ' }],
    }
    expect(extractReading(entry)).toBe('ねこ')
  })

  test('returns word itself when it is hiragana', () => {
    const entry: WiktEntry = { word: 'たべる', pos: 'verb', lang_code: 'ja' }
    expect(extractReading(entry)).toBe('たべる')
  })

  test('returns null when no reading found', () => {
    const entry: WiktEntry = { word: 'ABC', pos: 'noun', lang_code: 'ja' }
    expect(extractReading(entry)).toBeNull()
  })
})

describe('extractDefinitions', () => {
  test('parses glosses', () => {
    const entry: WiktEntry = {
      word: '猫', pos: 'noun', lang_code: 'ja',
      senses: [{ glosses: ['고양이'] }, { glosses: ['cat (animal)'] }],
    }
    expect(extractDefinitions(entry)).toEqual(['고양이', 'cat (animal)'])
  })

  test('deduplicates case-insensitively', () => {
    const entry: WiktEntry = {
      word: '猫', pos: 'noun', lang_code: 'ja',
      senses: [{ glosses: ['Cat'] }, { glosses: ['cat'] }],
    }
    expect(extractDefinitions(entry)).toHaveLength(1)
  })

  test('skips alt-of / form-of senses', () => {
    const entry: WiktEntry = {
      word: '猫', pos: 'noun', lang_code: 'ja',
      senses: [
        { glosses: ['고양이'] },
        { glosses: ['Alternative form'], tags: ['alt-of'] },
      ],
    }
    expect(extractDefinitions(entry)).toEqual(['고양이'])
  })

  test('returns empty for no senses', () => {
    const entry: WiktEntry = { word: '猫', pos: 'noun', lang_code: 'ja' }
    expect(extractDefinitions(entry)).toEqual([])
  })
})

describe('INCLUDED_POS filtering', () => {
  test('includes standard POS tags', () => {
    for (const pos of ['noun', 'verb', 'adj', 'particle', 'counter']) {
      expect(INCLUDED_POS.has(pos)).toBe(true)
    }
  })

  test('excludes non-standard POS', () => {
    expect(INCLUDED_POS.has('determiner')).toBe(false)
    expect(INCLUDED_POS.has('character')).toBe(false)
  })
})
