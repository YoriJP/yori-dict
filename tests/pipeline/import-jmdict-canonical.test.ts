import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, runImport } from '../../scripts/pipeline/import-jmdict-canonical'
import type { CanonicalSnapshot } from '../../src/domain/types'
import type { IdRegistry } from '../../src/domain/ids'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-jmdict-canonical-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('canonical JMdict import CLI', () => {
  test('parses CLI arguments', () => {
    const opts = parseArgs([
      '--file', 'jmdict.json',
      '--out', 'snapshot.json',
      '--registry', 'ids.json',
      '--limit', '10',
      '--imported-at', '2026-06-03T00:00:00.000Z',
    ])

    expect(opts).toMatchObject({
      file: 'jmdict.json',
      out: 'snapshot.json',
      registry: 'ids.json',
      limit: 10,
      importedAt: '2026-06-03T00:00:00.000Z',
    })
  })

  test('writes a canonical snapshot and stable ID registry', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'jmdict.json')
    const outPath = join(dir, 'snapshot.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(inputPath, JSON.stringify({
      version: 'test',
      words: [
        {
          id: '1358280',
          kanji: [
            { text: '食べる', common: true, priority: ['ichi1'] },
            { text: '喰べる' },
          ],
          kana: [{ text: 'たべる', common: true, appliesToKanji: ['食べる', '喰べる'] }],
          sense: [
            {
              partOfSpeech: ['v1', 'vt'],
              gloss: [{ lang: 'eng', text: 'to eat' }],
            },
          ],
        },
        {
          id: '3000000',
          kana: [{ text: 'ありがとう' }],
          sense: [
            {
              partOfSpeech: ['int'],
              gloss: [{ lang: 'eng', text: 'thank you' }],
            },
          ],
        },
      ],
    }))

    await runImport({
      file: inputPath,
      out: outPath,
      registry: registryPath,
      limit: null,
      importedAt: '2026-06-03T00:00:00.000Z',
    })

    const snapshot = await Bun.file(outPath).json() as CanonicalSnapshot
    const registry = await Bun.file(registryPath).json() as IdRegistry

    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[0].id).toBe('yde_00000001')
    expect(snapshot.entries[0].forms.map((form) => form.text)).toEqual(['食べる', '喰べる'])
    expect(snapshot.lookupAliases.map((alias) => alias.surface)).toContain('たべる')
    expect(registry.entries['jmdict:1358280']).toBe('yde_00000001')
    expect(registry.entries['jmdict:3000000']).toBe('yde_00000002')

    await runImport({
      file: inputPath,
      out: outPath,
      registry: registryPath,
      limit: 1,
      importedAt: '2026-06-03T00:00:00.000Z',
    })

    const rerunSnapshot = await Bun.file(outPath).json() as CanonicalSnapshot
    const rerunRegistry = await Bun.file(registryPath).json() as IdRegistry
    expect(rerunSnapshot.entries[0].id).toBe('yde_00000001')
    expect(rerunRegistry.entries['jmdict:1358280']).toBe('yde_00000001')
  })

  test('imports real JMdict XML shape', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'jmdict.xml')
    const outPath = join(dir, 'snapshot.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(inputPath, `
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
            <gloss xml:lang="ger">essen</gloss>
          </sense>
        </entry>
      </JMdict>
    `)

    await runImport({
      file: inputPath,
      out: outPath,
      registry: registryPath,
      limit: null,
      importedAt: '2026-06-03T00:00:00.000Z',
    })

    const snapshot = await Bun.file(outPath).json() as CanonicalSnapshot
    expect(snapshot.entries[0]).toMatchObject({
      id: 'yde_00000001',
      primaryForm: '食べる',
      primaryReading: 'たべる',
      ranking: { common: true, priority: ['ichi1'] },
    })
    expect(snapshot.entries[0].senses[0].partOfSpeech).toEqual(['v1', 'vt'])
    expect(snapshot.entries[0].senses[0].glosses.map((gloss) => `${gloss.lang}:${gloss.text}`)).toEqual([
      'en:to eat',
      'de:essen',
    ])
  })
})
