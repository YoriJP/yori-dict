import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyCanonicalOverlays } from '../../scripts/pipeline/apply-canonical-overlays'
import { buildCanonicalRelease } from '../../scripts/pipeline/build-canonical-release'
import { runBuildCurationQueue } from '../../scripts/pipeline/build-curation-queue'
import { runCreateAiCurationOverlays } from '../../scripts/pipeline/create-ai-curation-overlays'
import {
  parseArgs as parseCurationArgs,
  runCurationCommand,
} from '../../scripts/pipeline/curate-canonical-overlays'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import { saveIdRegistry } from '../../src/domain/registry-store'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'
import { CanonicalLookupService } from '../../src/runtime/canonical-lookup'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-curation-workflow-'))
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
            partOfSpeech: ['v1', 'vt'],
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
  await saveIdRegistry(path, registry)
}

describe('canonical curation workflow', () => {
  test('curates overlays, applies them, builds a release, and serves lookup data', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const overlayPath = join(dir, 'overlays.json')
    const registryPath = join(dir, 'registry', 'ids.json')
    const releasePath = join(dir, 'release.sqlite')

    await Bun.write(snapshotPath, JSON.stringify(snapshot()))
    await writeRegistry(registryPath)

    await runCurationCommand(parseCurationArgs([
      'replace-glosses',
      '--overlay', overlayPath,
      '--sense-id', 'yds_00000001',
      '--lang', 'zh-tw',
      '--gloss', '吃',
      '--imported-at', importedAt,
      '--approved',
    ]))

    const exampleOperation = await runCurationCommand(parseCurationArgs([
      'add-example',
      '--overlay', overlayPath,
      '--sense-id', 'yds_00000001',
      '--lang', 'zh-tw',
      '--japanese', '寿司を食べる。',
      '--translation', '我吃壽司。',
      '--imported-at', importedAt,
    ]))
    if (Array.isArray(exampleOperation)) throw new Error('expected one created operation')

    await runCurationCommand(parseCurationArgs([
      'approve',
      '--overlay', overlayPath,
      '--id', exampleOperation.id,
    ]))

    await applyCanonicalOverlays({
      snapshot: snapshotPath,
      overlay: overlayPath,
      out: snapshotPath,
      registry: registryPath,
    })
    await buildCanonicalRelease({ snapshot: snapshotPath, out: releasePath, overwrite: false })

    const db = new Database(releasePath, { readonly: true })
    try {
      const service = new CanonicalLookupService(db)
      const lookup = service.lookup({ query: '食べる', lang: 'zh-tw' })
      expect(lookup.entries[0]).toMatchObject({
        id: 'yde_00000001',
        definitions: ['吃'],
      })

      const entry = service.getEntry('yde_00000001', 'zh-tw')
      expect(entry?.senses[0].examples).toEqual([
        expect.objectContaining({
          lang: 'zh-tw',
          japanese: '寿司を食べる。',
          translation: '我吃壽司。',
        }),
      ])
    } finally {
      db.close()
    }
  })

  test('keeps queue items until AI gloss suggestions are approved and applied', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const queuePath = join(dir, 'queue.zh-tw.json')
    const suggestionsPath = join(dir, 'suggestions.jsonl')
    const overlayPath = join(dir, 'overlays.json')
    const registryPath = join(dir, 'registry', 'ids.json')
    const releasePath = join(dir, 'release.sqlite')

    await Bun.write(snapshotPath, JSON.stringify(snapshot()))
    await writeRegistry(registryPath)

    const initialQueue = await runBuildCurationQueue({
      snapshot: snapshotPath,
      lang: 'zh-tw',
      out: queuePath,
      commonOnly: false,
    })
    expect(initialQueue.items.map((item) => item.id)).toEqual(['missingGloss-yds_00000001-zh-tw'])

    await Bun.write(suggestionsPath, JSON.stringify({
      queueItemId: 'missingGloss-yds_00000001-zh-tw',
      text: '吃',
    }) + '\n')

    const operations = await runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-2.5-flash',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })
    expect(operations).toHaveLength(1)
    expect(operations[0].reviewStatus).toBe('unreviewed')

    const stillPendingQueue = await runBuildCurationQueue({
      snapshot: snapshotPath,
      lang: 'zh-tw',
      out: queuePath,
      commonOnly: false,
    })
    expect(stillPendingQueue.items).toHaveLength(1)

    await runCurationCommand(parseCurationArgs([
      'approve',
      '--overlay', overlayPath,
      '--id', operations[0].id,
    ]))

    await applyCanonicalOverlays({
      snapshot: snapshotPath,
      overlay: overlayPath,
      out: snapshotPath,
      registry: registryPath,
    })

    const resolvedQueue = await runBuildCurationQueue({
      snapshot: snapshotPath,
      lang: 'zh-tw',
      out: queuePath,
      commonOnly: false,
    })
    expect(resolvedQueue.items).toEqual([])

    await buildCanonicalRelease({ snapshot: snapshotPath, out: releasePath, overwrite: false })
    const db = new Database(releasePath, { readonly: true })
    try {
      const service = new CanonicalLookupService(db)
      const lookup = service.lookup({ query: '食べる', lang: 'zh-tw' })
      expect(lookup.entries[0]).toMatchObject({
        id: 'yde_00000001',
        definitions: ['吃'],
      })
    } finally {
      db.close()
    }
  })
})
