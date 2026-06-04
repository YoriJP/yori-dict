import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyCanonicalOverlays, parseArgs } from '../../scripts/pipeline/apply-canonical-overlays'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-canonical-overlays-'))
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
        ranking: {},
        sourceRefs: refs,
      },
    ],
    lookupAliases: [],
  }
}

async function writeRegistry(path: string): Promise<void> {
  const registry = createEmptyIdRegistry()
  registry.next.glosses = 2
  await Bun.write(path, JSON.stringify(registry))
}

describe('canonical overlay apply CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--overlay', 'overlays.json',
      '--out', 'out.json',
      '--registry', 'ids.json',
    ])).toEqual({
      snapshot: 'snapshot.json',
      overlay: 'overlays.json',
      out: 'out.json',
      registry: 'ids.json',
    })
  })

  test('applies approved overlays to a snapshot', async () => {
    const dir = makeTempDir()
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

    await applyCanonicalOverlays({
      snapshot: snapshotPath,
      overlay: overlayPath,
      out: snapshotPath,
      registry: registryPath,
    })

    const updated = await Bun.file(snapshotPath).json() as CanonicalSnapshot
    expect(updated.entries[0].senses[0].glosses[1]).toMatchObject({
      id: 'ydg_00000002',
      lang: 'zh-tw',
      text: '吃',
      sourceType: 'manual',
      sourceRefs: [{ kind: 'manual', sourceId: 'manual-gloss-1' }],
    })
  })
})
