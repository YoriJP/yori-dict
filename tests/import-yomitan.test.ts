import { describe, expect, test } from 'bun:test'
import { extractDefinitionTexts, extractExamplePairs, type YomitanDef } from '../scripts/import/yomitan'

describe('extractDefinitionTexts', () => {
  test('flattens plain and structured definitions', () => {
    const defs: YomitanDef[] = [
      'to study',
      { type: 'structured-content', content: ['to ', { tag: 'b', content: 'learn' }] },
    ]

    expect(extractDefinitionTexts(defs, 5)).toEqual(['to study', 'to learn'])
  })
})

describe('extractExamplePairs', () => {
  test('collects aligned ja/en example text from structured content', () => {
    const defs: YomitanDef[] = [
      {
        type: 'structured-content',
        content: [
          { tag: 'span', lang: 'ja', content: '学校へ行く。' },
          { tag: 'span', lang: 'en', content: 'I go to school.' },
        ],
      },
    ]

    expect(extractExamplePairs(defs, '学校', 'がっこう')).toEqual([
      { ja: '学校へ行く。', text: 'I go to school.' },
    ])
  })
})
