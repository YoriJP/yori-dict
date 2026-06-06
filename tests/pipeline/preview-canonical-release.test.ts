import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseArgs, previewCanonicalRelease } from '../../scripts/pipeline/preview-canonical-release'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-preview-canonical-release-'))
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

function snapshot(): CanonicalSnapshot {
  const refs = [sourceRef()]
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    entries: [
      {
        id: 'yde_00000001',
        language: 'ja',
        entryType: 'word',
        primaryForm: '食べる',
        primaryReading: 'たべる',
        forms: [
          {
            id: 'ydf_00000001',
            text: '食べる',
            normalizedText: '食べる',
            script: 'mixed',
            isPrimary: true,
            tags: [],
            sourceRefs: refs,
          },
        ],
        readings: [
          {
            id: 'ydr_00000001',
            text: 'たべる',
            normalizedText: 'たべる',
            system: 'kana',
            isPrimary: true,
            appliesToFormIds: 'all',
            tags: [],
            sourceRefs: refs,
          },
        ],
        senses: [
          {
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            order: 1,
            partOfSpeech: ['v1'],
            appliesToFormIds: 'all',
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [
              {
                id: 'ydg_00000001',
                senseId: 'yds_00000001',
                lang: 'en',
                text: 'to eat',
                sourceType: 'source',
                reviewStatus: 'approved',
                sourceRefs: refs,
              },
            ],
            examples: [],
            sourceRefs: refs,
          },
        ],
        ranking: { common: true },
        sourceRefs: refs,
      },
    ],
    lookupAliases: [
      {
        id: 'yda_00000001',
        surface: '食べる',
        normalizedSurface: '食べる',
        reading: 'たべる',
        normalizedReading: 'たべる',
        entryId: 'yde_00000001',
        formId: 'ydf_00000001',
        readingId: 'ydr_00000001',
        aliasType: 'dictionary',
        score: 100,
      },
    ],
  }
}

async function writeRegistry(path: string): Promise<void> {
  const registry = createEmptyIdRegistry()
  registry.next.glosses = 2
  await Bun.write(path, JSON.stringify(registry))
}

async function writeFixture(dir: string): Promise<{ snapshotPath: string; overlayPath: string; registryPath: string }> {
  const snapshotPath = join(dir, 'snapshot.json')
  const overlayPath = join(dir, 'overlays.json')
  const registryPath = join(dir, 'registry', 'ids.json')

  await Bun.write(snapshotPath, JSON.stringify(snapshot()))
  await writeRegistry(registryPath)
  await Bun.write(overlayPath, JSON.stringify({
    schemaVersion: '1.0.0',
    operations: [
      {
        id: 'manual-gloss-1',
        type: 'addGloss',
        sourceKind: 'manual',
        importedAt,
        reviewStatus: 'approved',
        senseId: 'yds_00000001',
        lang: 'zh-tw',
        text: '吃',
      },
    ],
  }))

  return { snapshotPath, overlayPath, registryPath }
}

describe('canonical release preview CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--overlay', 'overlays.json',
      '--registry', 'ids.json',
      '--out-dir', 'preview',
      '--lang', 'zh-tw',
      '--lookup', '食べる',
      '--entry-id', 'yde_00000001',
      '--overwrite',
    ])).toEqual({
      snapshot: 'snapshot.json',
      overlay: 'overlays.json',
      registry: 'ids.json',
      outDir: 'preview',
      lang: 'zh-tw',
      lookups: ['食べる'],
      entryIds: ['yde_00000001'],
      overwrite: true,
    })
  })

  test('builds a preview release and smoke checks touched entries', async () => {
    const dir = makeTempDir()
    const { snapshotPath, overlayPath, registryPath } = await writeFixture(dir)
    const outDir = join(dir, 'preview')

    const result = await previewCanonicalRelease({
      snapshot: snapshotPath,
      overlay: overlayPath,
      registry: registryPath,
      outDir,
      lang: 'zh-tw',
      lookups: ['食べる'],
      entryIds: [],
      overwrite: false,
    })

    expect(result).toMatchObject({
      snapshot: join(outDir, 'snapshot.preview.json'),
      releaseDb: join(outDir, 'release.preview.sqlite'),
      registry: join(outDir, 'ids.preview.json'),
      touchedEntryIds: ['yde_00000001'],
      lookupsChecked: 1,
      entriesChecked: 1,
    })

    const db = new Database(result.releaseDb, { readonly: true })
    try {
      const gloss = db.query<{ text: string; source_type: string }, [string]>(
        'SELECT text, source_type FROM glosses WHERE lang = ?1'
      ).get('zh-tw')
      expect(gloss).toEqual({ text: '吃', source_type: 'manual' })
    } finally {
      db.close()
    }
  })

  test('fails when lookup smoke checks do not return entries', async () => {
    const dir = makeTempDir()
    const { snapshotPath, overlayPath, registryPath } = await writeFixture(dir)

    await expect(previewCanonicalRelease({
      snapshot: snapshotPath,
      overlay: overlayPath,
      registry: registryPath,
      outDir: join(dir, 'preview'),
      lang: 'zh-tw',
      lookups: ['不存在'],
      entryIds: [],
      overwrite: false,
    })).rejects.toThrow('Preview smoke check failed: lookup returned no entries: 不存在')
  })
})
