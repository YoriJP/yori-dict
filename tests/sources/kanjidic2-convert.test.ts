import { describe, expect, test } from 'bun:test'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import { convertKanjidic2Character, convertKanjidic2Characters } from '../../src/sources/kanjidic2/convert'

const importedAt = '2026-06-03T00:00:00.000Z'

describe('convertKanjidic2Character', () => {
  test('converts meanings, readings, stats, and source refs', () => {
    const registry = createEmptyIdRegistry()
    const kanji = convertKanjidic2Character(
      {
        literal: '食',
        codepoint: '98df',
        meanings: [
          { text: 'eat' },
          { lang: 'zh-tw', text: '吃' },
          { lang: 'fr', text: 'ignored' },
        ],
        readings: [
          { type: 'ja_on', text: 'ショク' },
          { type: 'ja_kun', text: 'た.べる' },
          { type: 'unknown', text: 'ignored' },
        ],
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      },
      { registry, importedAt }
    )

    expect(kanji).toMatchObject({
      id: 'ydk_00000001',
      literal: '食',
      meanings: [
        { lang: 'en', text: 'eat' },
        { lang: 'zh-tw', text: '吃' },
      ],
      readings: [
        { type: 'onyomi', text: 'ショク' },
        { type: 'kunyomi', text: 'た.べる' },
      ],
      stats: {
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      },
    })
    expect(kanji?.sourceRefs).toEqual([
      {
        kind: 'kanjidic2',
        sourceId: '98df',
        license: 'CC-BY-SA-4.0',
        importedAt,
      },
    ])
  })

  test('skips invalid literals and reuses stable IDs', () => {
    const registry = createEmptyIdRegistry()
    const first = convertKanjidic2Character({ literal: '食' }, { registry, importedAt })
    const second = convertKanjidic2Character({ literal: '食' }, { registry, importedAt })
    const invalid = convertKanjidic2Character({ literal: '食べる' }, { registry, importedAt })

    expect(first?.id).toBe('ydk_00000001')
    expect(second?.id).toBe('ydk_00000001')
    expect(invalid).toBeNull()
  })
})

describe('convertKanjidic2Characters', () => {
  test('filters invalid records', () => {
    const registry = createEmptyIdRegistry()
    const result = convertKanjidic2Characters(
      [{ literal: '食' }, { literal: '食べる' }],
      { registry, importedAt }
    )

    expect(result.map((kanji) => kanji.literal)).toEqual(['食'])
  })
})
