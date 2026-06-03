import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  importKanjidic2Canonical,
  parseArgs,
} from '../../scripts/pipeline/import-kanjidic2-canonical'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-kanjidic2-canonical-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function sourceRef(): SourceRef {
  return {
    kind: 'jmdict',
    sourceId: '1358280',
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function emptyWordSnapshot(): CanonicalSnapshot {
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    entries: [],
    lookupAliases: [],
  }
}

describe('canonical KANJIDIC2 import CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--file', 'kanjidic2.json',
      '--snapshot', 'snapshot.json',
      '--out', 'out.json',
      '--registry', 'ids.json',
      '--imported-at', importedAt,
      '--limit', '10',
    ])).toEqual({
      file: 'kanjidic2.json',
      snapshot: 'snapshot.json',
      out: 'out.json',
      registry: 'ids.json',
      importedAt,
      limit: 10,
    })
  })

  test('writes kanji characters and stable IDs into the canonical snapshot', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'kanjidic2.json')
    const snapshotPath = join(dir, 'snapshot.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(emptyWordSnapshot()))
    await Bun.write(inputPath, JSON.stringify([
      {
        literal: '食',
        codepoint: '98df',
        meanings: [{ text: 'eat' }],
        readings: [{ type: 'ja_on', text: 'ショク' }],
        grade: 2,
        strokeCount: 9,
      },
    ]))

    await importKanjidic2Canonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.kanjiCharacters?.[0]).toMatchObject({
      id: 'ydk_00000001',
      literal: '食',
      meanings: [{ lang: 'en', text: 'eat' }],
      readings: [{ type: 'onyomi', text: 'ショク' }],
      stats: { grade: 2, strokeCount: 9 },
    })

    await importKanjidic2Canonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
    })

    const updated = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(updated.kanjiCharacters?.[0]?.id).toBe('ydk_00000001')
    expect(updated.kanjiCharacters).toHaveLength(1)
  })

  test('imports real KANJIDIC2 XML shape', async () => {
    const dir = makeTempDir()
    const inputPath = join(dir, 'kanjidic2.xml')
    const snapshotPath = join(dir, 'snapshot.json')
    const registryPath = join(dir, 'registry', 'ids.json')

    await Bun.write(snapshotPath, JSON.stringify(emptyWordSnapshot()))
    await Bun.write(inputPath, `
      <kanjidic2>
        <character>
          <literal>食</literal>
          <codepoint>
            <cp_value cp_type="ucs">98DF</cp_value>
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
              <meaning m_lang="zh-TW">吃</meaning>
            </rmgroup>
            <nanori>け</nanori>
          </reading_meaning>
        </character>
      </kanjidic2>
    `)

    await importKanjidic2Canonical({
      file: inputPath,
      snapshot: snapshotPath,
      out: snapshotPath,
      registry: registryPath,
      importedAt,
    })

    const snapshot = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(snapshot.kanjiCharacters?.[0]).toMatchObject({
      id: 'ydk_00000001',
      literal: '食',
      meanings: [
        { lang: 'en', text: 'eat' },
        { lang: 'zh-tw', text: '吃' },
      ],
      readings: [
        { type: 'onyomi', text: 'ショク' },
        { type: 'kunyomi', text: 'た.べる' },
        { type: 'nanori', text: 'け' },
      ],
      stats: {
        grade: 2,
        strokeCount: 9,
        frequency: 328,
        jlpt: 4,
      },
    })
  })
})
