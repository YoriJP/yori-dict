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

  test('handles array-based definitions from recent Jitendex redirects', () => {
    const defs: YomitanDef[] = [
      ['Ｎ響', ['redirected from Ｎ響']],
    ]

    expect(extractDefinitionTexts(defs, 5)).toEqual(['Ｎ響 redirected from Ｎ響'])
  })

  test('extracts only glossary text from rich structured content', () => {
    // Mirrors real Jitendex shape: POS tag, the gloss, an example sentence,
    // and attribution all live side by side under role-tagged nodes.
    const defs: YomitanDef[] = [
      {
        type: 'structured-content',
        content: [
          {
            tag: 'div',
            data: { content: 'sense-group' },
            content: [
              { tag: 'span', data: { class: 'tag', content: 'part-of-speech-info' }, content: 'noun' },
              {
                tag: 'div',
                data: { content: 'sense' },
                content: [
                  { tag: 'ul', data: { content: 'glossary' }, content: { tag: 'li', content: 'school' } },
                  {
                    tag: 'div',
                    data: { content: 'example-sentence' },
                    content: [
                      { tag: 'span', lang: 'ja', content: 'この学校は…' },
                      { tag: 'span', lang: 'en', content: 'This school…' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            tag: 'div',
            data: { content: 'attribution' },
            content: [{ tag: 'a', content: 'JMdict' }, ' | ', { tag: 'a', content: 'Tatoeba' }],
          },
        ],
      },
    ]

    expect(extractDefinitionTexts(defs, 8)).toEqual(['school'])
  })

  test('collects each glossary list item as a separate definition', () => {
    const defs: YomitanDef[] = [
      {
        type: 'structured-content',
        content: {
          tag: 'div',
          data: { content: 'sense' },
          content: {
            tag: 'ul',
            data: { content: 'glossary' },
            content: [
              { tag: 'li', content: 'to eat' },
              { tag: 'li', content: 'to live on (e.g. a salary)' },
            ],
          },
        },
      },
    ]

    expect(extractDefinitionTexts(defs, 8)).toEqual(['to eat', 'to live on (e.g. a salary)'])
  })

  test('yields nothing for redirect-only entries', () => {
    const defs: YomitanDef[] = [
      {
        type: 'structured-content',
        content: {
          tag: 'div',
          lang: 'ja',
          data: { content: 'redirect-glossary' },
          content: ['⟶', { tag: 'a', content: '企業体' }],
        },
      },
    ]

    expect(extractDefinitionTexts(defs, 8)).toEqual([])
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
