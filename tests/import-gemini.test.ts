import { describe, expect, test } from 'bun:test'
import {
  buildSelectionFilters,
  collectMissingKeys,
  parseArgs,
  parseUsageMetadata,
  resolvePricing,
} from '../scripts/import/gemini'
import type { CoreEntry, LangFile } from '../scripts/import/base'

function makeCoreEntry(overrides: Partial<CoreEntry> = {}): CoreEntry {
  return {
    word: '食べる',
    reading: 'たべる',
    partOfSpeech: ['verb'],
    common: false,
    jlpt: null,
    frequency: null,
    ...overrides,
  }
}

function makeLangFile(): LangFile {
  return {
    version: '2.0.0',
    lang: 'zh-tw',
    updatedAt: new Date().toISOString(),
    stats: {
      entries: 0,
      withExamples: 0,
      sources: {},
    },
    entries: {},
  }
}

describe('parseArgs', () => {
  test('parses new filtering and budget flags', () => {
    const opts = parseArgs([
      '--langs', 'zh-tw',
      '--common-only',
      '--min-frequency', '5000',
      '--jlpt-max', '3',
      '--exclude-regex', '^[a-z]+$',
      '--max-input-tokens', '1200',
      '--max-cost-usd', '2.5',
      '--report-file', 'reports/gemini.json',
    ])

    expect(opts.model).toBe('gemini-3.1-flash-lite')
    expect(opts.langs).toEqual(['zh-tw'])
    expect(opts.commonOnly).toBe(true)
    expect(opts.minFrequency).toBe(5000)
    expect(opts.jlptMax).toBe(3)
    expect(opts.excludeRegex).toBe('^[a-z]+$')
    expect(opts.maxInputTokens).toBe(1200)
    expect(opts.maxCostUsd).toBe(2.5)
    expect(opts.reportFile).toBe('reports/gemini.json')
  })
})

describe('collectMissingKeys', () => {
  test('filters and prioritizes missing entries using core metadata', () => {
    const target = makeLangFile()
    target.entries['既存:きそん'] = {
      definitions: ['existing'],
      examples: [],
      _defSources: { existing: ['manual'] },
    }

    const masterKeys = [
      '低頻度:ていひんど',
      '初心者:しょしんしゃ',
      '常用語:じょうようご',
      '!!:!!',
      '既存:きそん',
    ]

    const coreEntries: Record<string, CoreEntry> = {
      '低頻度:ていひんど': makeCoreEntry({ word: '低頻度', reading: 'ていひんど', common: true, jlpt: 2, frequency: 50000 }),
      '初心者:しょしんしゃ': makeCoreEntry({ word: '初心者', reading: 'しょしんしゃ', common: true, jlpt: 5, frequency: 900 }),
      '常用語:じょうようご': makeCoreEntry({ word: '常用語', reading: 'じょうようご', common: true, jlpt: 3, frequency: 2000 }),
      '!!:!!': makeCoreEntry({ word: '!!', reading: '!!', common: true, jlpt: 5, frequency: 10 }),
      '既存:きそん': makeCoreEntry({ word: '既存', reading: 'きそん', common: true, jlpt: 4, frequency: 100 }),
    }

    const filters = buildSelectionFilters({
      ...parseArgs([]),
      commonOnly: true,
      minFrequency: 5000,
      jlptMax: 3,
      excludeRegex: '^[\\p{P}\\p{S}]+$',
    })

    const result = collectMissingKeys(masterKeys, target, coreEntries, filters, 0, null)

    expect(result.totalMissing).toBe(4)
    expect(result.eligibleMissing).toBe(2)
    expect(result.excludedByFrequency).toBe(1)
    expect(result.excludedByRegex).toBe(1)
    expect(result.keys).toEqual(['初心者:しょしんしゃ', '常用語:じょうようご'])
  })
})

describe('resolvePricing', () => {
  test('returns preset pricing for the default model', () => {
    const pricing = resolvePricing(parseArgs([]))

    expect(pricing).toEqual({
      inputUsdPerMillion: 0.25,
      outputUsdPerMillion: 1.5,
    })
  })

  test('allows CLI overrides for unknown models', () => {
    const pricing = resolvePricing(parseArgs([
      '--model', 'custom-model',
      '--input-price-per-1m', '0.5',
      '--output-price-per-1m', '2',
    ]))

    expect(pricing).toEqual({
      inputUsdPerMillion: 0.5,
      outputUsdPerMillion: 2,
    })
  })
})

describe('parseUsageMetadata', () => {
  test('accepts camelCase and snake_case usage fields', () => {
    expect(parseUsageMetadata({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 3,
      totalTokenCount: 123,
    })).toEqual({
      promptTokens: 100,
      candidateTokens: 20,
      thoughtsTokens: 3,
      totalTokens: 123,
    })

    expect(parseUsageMetadata({
      prompt_token_count: 7,
      candidates_token_count: 8,
      thoughts_token_count: 1,
      total_token_count: 16,
    })).toEqual({
      promptTokens: 7,
      candidateTokens: 8,
      thoughtsTokens: 1,
      totalTokens: 16,
    })
  })
})
