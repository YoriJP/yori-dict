import { describe, test, expect } from 'bun:test'
import {
  mapPos,
  extractReading,
  extractDefinitions,
  isFilteredKaikkiDefinition,
  parseEntry,
  katakanaToHiragana,
  resolveCanonicalKey,
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

  test('filters old-form and meta glosses', () => {
    const entry: WiktEntry = {
      word: '發音', pos: 'noun', lang_code: 'ja',
      senses: [
        { glosses: ['発音的舊字體形式'] },
        { glosses: ['useful modern gloss'] },
      ],
    }
    expect(extractDefinitions(entry)).toEqual(['useful modern gloss'])
  })
})

describe('isFilteredKaikkiDefinition', () => {
  test('matches old-form / variant meta glosses', () => {
    expect(isFilteredKaikkiDefinition('電脳的舊字體形式')).toBe(true)
    expect(isFilteredKaikkiDefinition('発音的舊字體形式')).toBe(true)
    expect(isFilteredKaikkiDefinition('猫的異體字')).toBe(true)
    expect(isFilteredKaikkiDefinition('國的简体字')).toBe(true)
  })

  test('keeps ordinary learner-facing glosses', () => {
    expect(isFilteredKaikkiDefinition('以漢語書寫的文章')).toBe(false)
    expect(isFilteredKaikkiDefinition('法律學的用語')).toBe(false)
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

  test('returns null when all definitions are filtered meta glosses', () => {
    const raw: WiktEntry = {
      word: '發音',
      pos: 'noun',
      lang_code: 'ja',
      forms: [{ form: 'はつおん' }],
      senses: [{ glosses: ['発音的舊字體形式'] }],
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

describe('resolveCanonicalKey', () => {
  test('uses exact key when present', () => {
    const key = resolveCanonicalKey('文化', 'ぶんか', {
      coreKeys: new Set(['文化:ぶんか']),
      coreEntries: {
        '文化:ぶんか': {
          word: '文化',
          reading: 'ぶんか',
          partOfSpeech: ['noun'],
          common: true,
          jlpt: null,
          frequency: 100,
        },
      },
      coreByWord: new Map([['文化', ['文化:ぶんか']]]),
      coreByReading: new Map([['ぶんか', ['文化:ぶんか']]]),
    })

    expect(key).toBe('文化:ぶんか')
  })

  test('uses reading to disambiguate same-word candidates', () => {
    const key = resolveCanonicalKey('上手', 'じょうず', {
      coreKeys: new Set(['上手:じょうず', '上手:うわて']),
      coreEntries: {
        '上手:じょうず': {
          word: '上手',
          reading: 'じょうず',
          partOfSpeech: ['na-adjective'],
          common: true,
          jlpt: null,
          frequency: 120,
        },
        '上手:うわて': {
          word: '上手',
          reading: 'うわて',
          partOfSpeech: ['noun'],
          common: false,
          jlpt: null,
          frequency: 5000,
        },
      },
      coreByWord: new Map([['上手', ['上手:じょうず', '上手:うわて']]]),
      coreByReading: new Map([['じょうず', ['上手:じょうず']], ['うわて', ['上手:うわて']]]),
    })

    expect(key).toBe('上手:じょうず')
  })
})
