import { describe, test, expect } from 'bun:test'
import {
  mapPos,
  extractReading,
  extractDefinitions,
  parseEntry,
  katakanaToHiragana,
  type WiktEntry,
} from '../scripts/import/kaikki'

// ============================================================================
// POS mapping
// ============================================================================

// ============================================================================
// katakanaToHiragana
// ============================================================================

describe('katakanaToHiragana', () => {
  test('converts katakana letters to hiragana', () => {
    expect(katakanaToHiragana('ネコ')).toBe('ねこ')
  })

  test('preserves long vowel mark ー', () => {
    expect(katakanaToHiragana('コーヒー')).toBe('こーひー')
    expect(katakanaToHiragana('ラーメン')).toBe('らーめん')
  })

  test('preserves non-katakana characters', () => {
    expect(katakanaToHiragana('ABCネコ123')).toBe('ABCねこ123')
  })
})

// ============================================================================
// POS mapping
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

// ============================================================================
// extractReading
// ============================================================================

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

// ============================================================================
// extractDefinitions
// ============================================================================

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

// ============================================================================
// parseEntry — end-to-end
// ============================================================================

describe('parseEntry', () => {
  test('converts a raw kaikki JSON entry into a ParsedWiktEntry', () => {
    const raw: WiktEntry = {
      word: '食べる',
      pos: 'verb',
      lang_code: 'ja',
      forms: [{ form: 'たべる' }],
      senses: [
        { glosses: ['먹다'] },
        { glosses: ['섭취하다'] },
      ],
    }

    const result = parseEntry(raw)
    expect(result).not.toBeNull()
    expect(result!.word).toBe('食べる')
    expect(result!.reading).toBe('たべる')
    expect(result!.pos).toBe('verb')
    expect(result!.definitions).toEqual(['먹다', '섭취하다'])
  })

  test('returns null for non-Japanese entries', () => {
    const raw: WiktEntry = {
      word: 'hello', pos: 'noun', lang_code: 'en',
      senses: [{ glosses: ['greeting'] }],
    }
    expect(parseEntry(raw)).toBeNull()
  })

  test('returns null for excluded POS', () => {
    const raw: WiktEntry = {
      word: '食べる', pos: 'determiner', lang_code: 'ja',
      forms: [{ form: 'たべる' }],
      senses: [{ glosses: ['test'] }],
    }
    expect(parseEntry(raw)).toBeNull()
  })

  test('returns null when no reading can be extracted', () => {
    const raw: WiktEntry = {
      word: 'ABC', pos: 'noun', lang_code: 'ja',
      senses: [{ glosses: ['test'] }],
    }
    expect(parseEntry(raw)).toBeNull()
  })

  test('returns null when no definitions found', () => {
    const raw: WiktEntry = {
      word: '食べる', pos: 'verb', lang_code: 'ja',
      forms: [{ form: 'たべる' }],
      senses: [],
    }
    expect(parseEntry(raw)).toBeNull()
  })

  test('maps POS in the result', () => {
    const raw: WiktEntry = {
      word: '猫', pos: 'adj', lang_code: 'ja',
      forms: [{ form: 'ねこ' }],
      senses: [{ glosses: ['cute'] }],
    }
    expect(parseEntry(raw)!.pos).toBe('adjective')
  })
})
