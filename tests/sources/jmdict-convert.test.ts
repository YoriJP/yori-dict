import { describe, expect, test } from 'bun:test'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  convertJmdictToSnapshot,
  convertJmdictWordToEntry,
  type JmdictWord,
} from '../../src/sources/jmdict/convert'

const importedAt = '2026-06-03T00:00:00.000Z'

function convert(word: JmdictWord) {
  return convertJmdictWordToEntry(word, {
    importedAt,
    registry: createEmptyIdRegistry(),
  })
}

describe('convertJmdictWordToEntry', () => {
  test('preserves forms, readings, senses, glosses, and source refs', () => {
    const { entry, lookupAliases } = convert({
      id: '1358280',
      kanji: [
        { text: '食べる', common: true, priority: ['ichi1'] },
        { text: '喰べる', tags: ['rarely-used kanji form'] },
      ],
      kana: [
        { text: 'たべる', common: true, appliesToKanji: ['食べる', '喰べる'], priority: ['ichi1'] },
      ],
      sense: [
        {
          partOfSpeech: ['v1', 'vt'],
          gloss: [
            { lang: 'eng', text: 'to eat' },
            { lang: 'ger', text: 'essen' },
          ],
        },
      ],
    })

    expect(entry.id).toBe('yde_00000001')
    expect(entry.primaryForm).toBe('食べる')
    expect(entry.primaryReading).toBe('たべる')
    expect(entry.forms.map((form) => form.text)).toEqual(['食べる', '喰べる'])
    expect(entry.readings).toHaveLength(1)
    expect(entry.readings[0].appliesToFormIds).toEqual(['ydf_00000001', 'ydf_00000002'])
    expect(entry.senses).toHaveLength(1)
    expect(entry.senses[0].partOfSpeech).toEqual(['v1', 'vt'])
    expect(entry.senses[0].glosses.map((gloss) => `${gloss.lang}:${gloss.text}`)).toEqual([
      'en:to eat',
      'de:essen',
    ])
    expect(entry.sourceRefs[0]).toMatchObject({ kind: 'jmdict', sourceId: '1358280' })
    expect(entry.ranking).toMatchObject({ common: true, priority: ['ichi1'] })

    expect(lookupAliases.map((alias) => `${alias.aliasType}:${alias.surface}`)).toEqual([
      'dictionary:食べる',
      'variant:喰べる',
      'reading:たべる',
    ])
  })

  test('keeps multiple senses separate instead of flattening POS', () => {
    const { entry } = convert({
      id: '2000000',
      kanji: [{ text: '上手' }],
      kana: [{ text: 'じょうず' }],
      sense: [
        {
          partOfSpeech: ['adj-na'],
          gloss: [{ lang: 'eng', text: 'skillful' }],
        },
        {
          partOfSpeech: ['n'],
          gloss: [{ lang: 'eng', text: 'upper part' }],
        },
      ],
    })

    expect(entry.senses).toHaveLength(2)
    expect(entry.senses[0]).toMatchObject({ order: 1, partOfSpeech: ['adj-na'] })
    expect(entry.senses[1]).toMatchObject({ order: 2, partOfSpeech: ['n'] })
    expect(entry.senses.flatMap((sense) => sense.partOfSpeech)).toEqual(['adj-na', 'n'])
  })

  test('supports kana-only words with a form and reading', () => {
    const { entry, lookupAliases } = convert({
      id: '3000000',
      kana: [{ text: 'ありがとう', common: true }],
      sense: [
        {
          partOfSpeech: ['int'],
          gloss: [{ lang: 'eng', text: 'thank you' }],
        },
      ],
    })

    expect(entry.forms).toHaveLength(1)
    expect(entry.forms[0]).toMatchObject({ text: 'ありがとう', script: 'kana', isPrimary: true })
    expect(entry.readings[0]).toMatchObject({ text: 'ありがとう', isPrimary: true })
    expect(lookupAliases.map((alias) => alias.aliasType)).toEqual(['dictionary'])
  })

  test('keeps duplicate kana elements as separate deterministic readings', () => {
    const { entry } = convert({
      id: '9999999',
      kanji: [
        { text: '開く' },
        { text: '空く' },
      ],
      kana: [
        { text: 'あく', appliesToKanji: ['開く'], tags: ['word usually written using kana alone'] },
        { text: 'あく', appliesToKanji: ['空く'] },
      ],
      sense: [
        {
          partOfSpeech: ['v5k'],
          appliesToKana: ['あく'],
          gloss: [{ lang: 'eng', text: 'to open' }],
        },
      ],
    })

    expect(entry.readings).toHaveLength(2)
    expect(new Set(entry.readings.map((reading) => reading.id)).size).toBe(2)
    expect(entry.readings.map((reading) => reading.text)).toEqual(['あく', 'あく'])
    expect(entry.senses[0].appliesToReadingIds).toEqual(['ydr_00000001', 'ydr_00000002'])
  })

  test('skips glosses in unsupported target languages', () => {
    const { entry } = convert({
      id: '9999998',
      kanji: [{ text: '試験' }],
      kana: [{ text: 'しけん' }],
      sense: [
        {
          partOfSpeech: ['n'],
          gloss: [
            { lang: 'eng', text: 'exam' },
            { lang: 'fre', text: 'examen' },
          ],
        },
      ],
    })

    expect(entry.senses[0].glosses.map((gloss) => `${gloss.lang}:${gloss.text}`)).toEqual(['en:exam'])
  })

  test('maps sense restrictions to Yori form and reading ids', () => {
    const { entry } = convert({
      id: '4000000',
      kanji: [{ text: '今日' }, { text: 'こんにち' }],
      kana: [{ text: 'きょう' }, { text: 'こんにち' }],
      sense: [
        {
          partOfSpeech: ['n-adv'],
          appliesToKanji: ['今日'],
          appliesToKana: ['きょう'],
          gloss: [{ lang: 'eng', text: 'today' }],
        },
        {
          partOfSpeech: ['n-t'],
          appliesToKanji: ['今日'],
          appliesToKana: ['こんにち'],
          gloss: [{ lang: 'eng', text: 'these days' }],
        },
      ],
    })

    expect(entry.senses[0].appliesToFormIds).toEqual(['ydf_00000001'])
    expect(entry.senses[0].appliesToReadingIds).toEqual(['ydr_00000001'])
    expect(entry.senses[1].appliesToFormIds).toEqual(['ydf_00000001'])
    expect(entry.senses[1].appliesToReadingIds).toEqual(['ydr_00000002'])
  })
})

describe('convertJmdictToSnapshot', () => {
  test('emits a valid canonical snapshot', () => {
    const registry = createEmptyIdRegistry()
    const snapshot = convertJmdictToSnapshot({
      version: 'test',
      words: [
        {
          id: '1358280',
          kanji: [{ text: '食べる', common: true }],
          kana: [{ text: 'たべる', common: true }],
          sense: [{ partOfSpeech: ['v1'], gloss: [{ lang: 'eng', text: 'to eat' }] }],
        },
        {
          id: '3000000',
          kana: [{ text: 'ありがとう' }],
          sense: [{ partOfSpeech: ['int'], gloss: [{ lang: 'eng', text: 'thank you' }] }],
        },
      ],
    }, {
      importedAt,
      registry,
    })

    const result = validateCanonicalSnapshot(snapshot)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['yde_00000001', 'yde_00000002'])
  })
})
