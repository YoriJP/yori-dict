import { describe, expect, test } from 'bun:test'
import {
  buildLanguageGapReport,
  buildRankedCoreEntries,
  hasKanji,
  isShortDefinition,
  type AuditLanguage,
} from '../scripts/audit/kanji-vocab-gaps'
import type { CoreEntry, LangEntry } from '../scripts/import/base'

function makeCoreEntry(overrides: Partial<CoreEntry> = {}): CoreEntry {
  return {
    word: '文化',
    reading: 'ぶんか',
    partOfSpeech: ['noun'],
    common: true,
    jlpt: null,
    frequency: 100,
    ...overrides,
  }
}

function makeLangEntry(definitions: string[], sources: Record<string, string[]>): LangEntry {
  return {
    definitions,
    examples: [],
    _defSources: sources,
  }
}

describe('hasKanji', () => {
  test('detects kanji-bearing words', () => {
    expect(hasKanji('文化')).toBe(true)
    expect(hasKanji('たべる')).toBe(false)
  })
})

describe('buildRankedCoreEntries', () => {
  test('prioritizes common entries and then lower frequency', () => {
    const ranked = buildRankedCoreEntries({
      '経験:けいけん': makeCoreEntry({ word: '経験', reading: 'けいけん', common: true, frequency: 300 }),
      '文化:ぶんか': makeCoreEntry({ word: '文化', reading: 'ぶんか', common: true, frequency: 100 }),
      '猫:ねこ': makeCoreEntry({ word: '猫', reading: 'ねこ', common: false, frequency: 1 }),
      'たべる:たべる': makeCoreEntry({ word: 'たべる', reading: 'たべる', common: true, frequency: 1 }),
    })

    expect(ranked.map((entry) => entry.key)).toEqual([
      '文化:ぶんか',
      '経験:けいけん',
      '猫:ねこ',
    ])
  })
})

describe('buildLanguageGapReport', () => {
  test('classifies missing, thin, and weak fallback entries', () => {
    const lang = 'en' as AuditLanguage
    const ranked = buildRankedCoreEntries({
      '文化:ぶんか': makeCoreEntry({ word: '文化', reading: 'ぶんか', common: true, frequency: 100 }),
      '勉強:べんきょう': makeCoreEntry({ word: '勉強', reading: 'べんきょう', common: true, frequency: 200 }),
      '情報:じょうほう': makeCoreEntry({ word: '情報', reading: 'じょうほう', common: false, frequency: 50 }),
    })

    const report = buildLanguageGapReport(
      lang,
      ranked,
      {
        '勉強:べんきょう': makeLangEntry(['Use'], { Use: ['ai'] }),
        '情報:じょうほう': makeLangEntry(
          ['To express ideas and values through shared customs and institutions'],
          { 'To express ideas and values through shared customs and institutions': ['jmdict'] }
        ),
      },
      10
    )

    expect(report.missingCount).toBe(1)
    expect(report.thinCount).toBe(1)
    expect(report.weakFallbackCount).toBe(1)

    expect(report.missingDefinitions[0].key).toBe('文化:ぶんか')
    expect(report.thinDefinitions[0].key).toBe('勉強:べんきょう')
    expect(report.weakFallbackOnly[0].key).toBe('勉強:べんきょう')
  })
})

describe('isShortDefinition', () => {
  test('uses language-aware thresholds', () => {
    expect(isShortDefinition('Use', 'en')).toBe(true)
    expect(isShortDefinition('To express ideas through institutions', 'en')).toBe(false)
    expect(isShortDefinition('文化', 'zh-cn')).toBe(true)
  })
})
