import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, rebuildCanonical } from '../../scripts/pipeline/rebuild-canonical'
import { CanonicalLookupService } from '../../src/runtime/canonical-lookup'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-rebuild-canonical-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

const jmdictXml = `
<JMdict>
  <entry>
    <ent_seq>1358280</ent_seq>
    <k_ele>
      <keb>食べる</keb>
      <ke_pri>ichi1</ke_pri>
    </k_ele>
    <r_ele>
      <reb>たべる</reb>
      <re_restr>食べる</re_restr>
      <re_pri>ichi1</re_pri>
    </r_ele>
    <sense>
      <pos>&v1;</pos>
      <pos>&vt;</pos>
      <gloss>to eat</gloss>
    </sense>
  </entry>
</JMdict>
`

const kanjidic2Xml = `
<kanjidic2>
  <character>
    <literal>食</literal>
    <codepoint>
      <cp_value cp_type="ucs">98DF</cp_value>
    </codepoint>
    <misc>
      <grade>2</grade>
      <stroke_count>9</stroke_count>
    </misc>
    <reading_meaning>
      <rmgroup>
        <reading r_type="ja_on">ショク</reading>
        <meaning>eat</meaning>
      </rmgroup>
    </reading_meaning>
  </character>
</kanjidic2>
`

describe('canonical rebuild pipeline', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--jmdict-file', 'JMdict_e.xml',
      '--kanjidic2-file', 'kanjidic2.xml',
      '--snapshot', 'snapshot.json',
      '--registry', 'ids.json',
      '--release-db', 'release.sqlite',
      '--imported-at', importedAt,
      '--jmdict-limit', '1',
      '--kanjidic2-limit', '1',
      '--tatoeba-file', 'examples.json',
      '--tatoeba-lang', 'en',
      '--tatoeba-max-examples-per-sense', '2',
      '--overwrite',
    ])).toMatchObject({
      jmdictFile: 'JMdict_e.xml',
      kanjidic2File: 'kanjidic2.xml',
      tatoebaFile: 'examples.json',
      tatoebaLang: 'en',
      tatoebaMaxExamplesPerSense: 2,
      snapshot: 'snapshot.json',
      registry: 'ids.json',
      releaseDb: 'release.sqlite',
      importedAt,
      jmdictLimit: 1,
      kanjidic2Limit: 1,
      overwrite: true,
    })
  })

  test('builds a canonical release DB from local JMdict and KANJIDIC2 XML', async () => {
    const dir = makeTempDir()
    const rawJmdictPath = join(dir, 'JMdict_e.xml')
    const rawKanjidic2Path = join(dir, 'kanjidic2.xml')
    const tatoebaPath = join(dir, 'examples.json')
    const jmdictSource = join(dir, 'sources', 'jmdict.xml')
    const kanjidic2Source = join(dir, 'sources', 'kanjidic2.xml')
    const snapshotPath = join(dir, 'snapshot.json')
    const registryPath = join(dir, 'registry', 'ids.json')
    const releaseDbPath = join(dir, 'release.sqlite')

    await Bun.write(rawJmdictPath, jmdictXml)
    await Bun.write(rawKanjidic2Path, kanjidic2Xml)
    await Bun.write(tatoebaPath, JSON.stringify([
      {
        japaneseId: '100',
        translationId: '200',
        japanese: '寿司を食べる。',
        translation: 'I eat sushi.',
        lang: 'en',
      },
    ]))

    await rebuildCanonical({
      jmdictFile: rawJmdictPath,
      jmdictUrl: 'unused',
      jmdictSource,
      kanjidic2File: rawKanjidic2Path,
      kanjidic2Url: 'unused',
      kanjidic2Source,
      tatoebaFile: tatoebaPath,
      tatoebaMaxExamplesPerSense: 3,
      snapshot: snapshotPath,
      registry: registryPath,
      releaseDb: releaseDbPath,
      importedAt,
      jmdictLimit: null,
      skipPrepare: false,
      overwrite: true,
    })

    const db = new Database(releaseDbPath, { readonly: true })
    try {
      const entry = db.query<{ public_id: string; primary_form: string }, []>(
        'SELECT public_id, primary_form FROM entries'
      ).get()
      expect(entry).toEqual({ public_id: 'yde_00000001', primary_form: '食べる' })

      const kanji = db.query<{ public_id: string; literal: string }, []>(
        'SELECT public_id, literal FROM kanji_characters'
      ).get()
      expect(kanji).toEqual({ public_id: 'ydk_00000001', literal: '食' })

      const service = new CanonicalLookupService(db)
      expect(service.lookup({ query: '食べる', lang: 'en' }).entries[0]).toMatchObject({
        id: 'yde_00000001',
        definitions: ['to eat'],
      })
      expect(service.getKanji('食', 'en')).toMatchObject({
        id: 'ydk_00000001',
        literal: '食',
        meanings: [{ lang: 'en', text: 'eat' }],
      })
      expect(service.getEntry('yde_00000001', 'en')?.senses[0].examples).toEqual([
        {
          id: 'ydx_00000001',
          senseId: 'yds_00000001',
          lang: 'en',
          japanese: '寿司を食べる。',
          translation: 'I eat sushi.',
          sourceRefs: [
            {
              kind: 'tatoeba',
              sourceId: '100-200',
              license: 'CC-BY 2.0 FR',
              importedAt,
            },
          ],
        },
      ])
    } finally {
      db.close()
    }
  })

  test('requires prepared source files when skipping preparation', async () => {
    const dir = makeTempDir()

    await expect(rebuildCanonical({
      jmdictUrl: 'unused',
      jmdictSource: join(dir, 'missing-jmdict.xml'),
      kanjidic2Url: 'unused',
      kanjidic2Source: join(dir, 'missing-kanjidic2.xml'),
      tatoebaMaxExamplesPerSense: 3,
      snapshot: join(dir, 'snapshot.json'),
      registry: join(dir, 'ids.json'),
      releaseDb: join(dir, 'release.sqlite'),
      importedAt,
      jmdictLimit: null,
      skipPrepare: true,
      overwrite: false,
    })).rejects.toThrow('Prepared source not found')
  })
})
