import { describe, expect, test } from 'bun:test'
import { parseKanjidic2Xml } from '../../src/sources/kanjidic2/xml'

describe('parseKanjidic2Xml', () => {
  test('parses KANJIDIC2 character blocks into simplified records', () => {
    const result = parseKanjidic2Xml(`
      <?xml version="1.0" encoding="UTF-8"?>
      <kanjidic2>
        <character>
          <literal>食</literal>
          <codepoint>
            <cp_value cp_type="ucs">98DF</cp_value>
            <cp_value cp_type="jis208">3F29</cp_value>
          </codepoint>
          <misc>
            <grade>2</grade>
            <stroke_count>9</stroke_count>
            <freq>328</freq>
            <jlpt>4</jlpt>
          </misc>
          <reading_meaning>
            <rmgroup>
              <reading r_type="ja_on">ショク</reading>
              <reading r_type="ja_kun">た.べる</reading>
              <meaning>eat</meaning>
              <meaning m_lang="fr">manger</meaning>
              <meaning m_lang="zh-TW">吃</meaning>
            </rmgroup>
            <nanori>け</nanori>
          </reading_meaning>
        </character>
      </kanjidic2>
    `)

    expect(result).toEqual([
      {
        literal: '食',
        codepoint: '98df',
        meanings: [
          { lang: 'en', text: 'eat' },
          { lang: 'fr', text: 'manger' },
          { lang: 'zh-TW', text: '吃' },
        ],
        readings: [
          { type: 'ja_on', text: 'ショク' },
          { type: 'ja_kun', text: 'た.べる' },
          { type: 'nanori', text: 'け' },
        ],
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      },
    ])
  })

  test('decodes XML entities', () => {
    const result = parseKanjidic2Xml(`
      <kanjidic2>
        <character>
          <literal>仮</literal>
          <reading_meaning>
            <rmgroup>
              <meaning>temporary &amp; provisional</meaning>
            </rmgroup>
          </reading_meaning>
        </character>
      </kanjidic2>
    `)

    expect(result[0]?.meanings).toEqual([
      { lang: 'en', text: 'temporary & provisional' },
    ])
  })
})
