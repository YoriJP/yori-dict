import { describe, expect, test } from 'bun:test'
import { parseJmdictXml } from '../../src/sources/jmdict/xml'

const fixtureXml = `
<JMdict>
  <entry>
    <ent_seq>1358280</ent_seq>
    <k_ele>
      <keb>食べる</keb>
      <ke_pri>ichi1</ke_pri>
    </k_ele>
    <k_ele>
      <keb>喰べる</keb>
      <ke_inf>&rK;</ke_inf>
    </k_ele>
    <r_ele>
      <reb>たべる</reb>
      <re_restr>食べる</re_restr>
      <re_restr>喰べる</re_restr>
      <re_pri>ichi1</re_pri>
    </r_ele>
    <sense>
      <pos>&v1;</pos>
      <pos>&vt;</pos>
      <gloss>to eat</gloss>
      <gloss xml:lang="ger">essen</gloss>
    </sense>
    <sense>
      <stagk>食べる</stagk>
      <stagr>たべる</stagr>
      <pos>&exp;</pos>
      <misc>&col;</misc>
      <gloss>to make a living</gloss>
    </sense>
  </entry>
  <entry>
    <ent_seq>3000000</ent_seq>
    <r_ele>
      <reb>ありがとう</reb>
      <re_nokanji/>
    </r_ele>
    <sense>
      <pos>&int;</pos>
      <gloss>thank you</gloss>
    </sense>
  </entry>
</JMdict>
`

describe('parseJmdictXml', () => {
  test('parses JMdict XML entries into simplified records', () => {
    const parsed = parseJmdictXml(fixtureXml)

    expect(parsed.words).toHaveLength(2)
    expect(parsed.words[0]).toEqual({
      id: '1358280',
      kanji: [
        { text: '食べる', common: true, tags: [], priority: ['ichi1'] },
        { text: '喰べる', common: false, tags: ['rK'], priority: [] },
      ],
      kana: [
        {
          text: 'たべる',
          common: true,
          tags: [],
          priority: ['ichi1'],
          appliesToKanji: ['食べる', '喰べる'],
        },
      ],
      sense: [
        {
          partOfSpeech: ['v1', 'vt'],
          appliesToKanji: 'all',
          appliesToKana: 'all',
          field: [],
          misc: [],
          dialect: [],
          gloss: [
            { lang: 'eng', text: 'to eat' },
            { lang: 'ger', text: 'essen' },
          ],
        },
        {
          partOfSpeech: ['exp'],
          appliesToKanji: ['食べる'],
          appliesToKana: ['たべる'],
          field: [],
          misc: ['col'],
          dialect: [],
          gloss: [{ lang: 'eng', text: 'to make a living' }],
        },
      ],
    })
    expect(parsed.words[1].kana[0].tags).toEqual(['no kanji'])
  })
})
