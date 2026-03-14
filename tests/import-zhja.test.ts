import { describe, expect, test } from 'bun:test'
import {
  extractJaCandidates,
  normalizeZhjaTerm,
  selectZhjaDefinitions,
} from '../scripts/import/zhja'

describe('extractJaCandidates', () => {
  test('returns ordered candidates with confidence', () => {
    expect(extractJaCandidates('偶然', '偶然\n名詞 ぐうぜん')).toEqual([
      { value: '偶然', confidence: 3 },
      { value: 'ぐうぜん', confidence: 1 },
    ])
  })

  test('extracts katakana loanword candidates', () => {
    expect(extractJaCandidates('快門', '快門\n名詞 シャッター')).toEqual([
      { value: '快門', confidence: 3 },
      { value: 'シャッター', confidence: 2 },
    ])
  })
})

describe('normalizeZhjaTerm', () => {
  test('normalizes to simplified Chinese and drops invalid terms', () => {
    const toSimplified = (text: string) => text.replaceAll('門', '门')

    expect(normalizeZhjaTerm('快門', toSimplified)).toBe('快门')
    expect(normalizeZhjaTerm('broker', toSimplified)).toBeNull()
    expect(normalizeZhjaTerm('非常非常非常非常長的中文詞', toSimplified)).toBeNull()
  })
})

describe('selectZhjaDefinitions', () => {
  test('prefers exact/shared matches and caps noisy synonym lists', () => {
    const selected = selectZhjaDefinitions([
      { term: '偶然', hits: 1, maxConfidence: 3 },
      { term: '碰巧', hits: 1, maxConfidence: 1 },
      { term: '巧合', hits: 1, maxConfidence: 1 },
      { term: '偶合', hits: 1, maxConfidence: 1 },
      { term: '侥幸', hits: 1, maxConfidence: 1 },
    ], '偶然', 3)

    expect(selected).toEqual(['偶然'])
  })

  test('penalizes one-character broker-style noise when evidence is otherwise equal', () => {
    const selected = selectZhjaDefinitions([
      { term: '侩', hits: 2, maxConfidence: 2 },
      { term: '经纪人', hits: 2, maxConfidence: 2 },
      { term: '掮客', hits: 2, maxConfidence: 2 },
      { term: '中介', hits: 2, maxConfidence: 2 },
    ], 'ブローカー', 3)

    expect(selected).toHaveLength(3)
    expect(selected).not.toContain('侩')
    expect(selected).toEqual(expect.arrayContaining(['中介', '掮客', '经纪人']))
  })
})
