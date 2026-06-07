import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  validateCanonicalOverlays,
} from '../../scripts/pipeline/validate-canonical-overlays'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import { saveIdRegistry } from '../../src/domain/registry-store'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-validate-overlays-'))
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
  await saveIdRegistry(path, registry)
}

describe('canonical overlay validation CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--overlay', 'overlays.json',
      '--snapshot', 'snapshot.json',
      '--registry', 'ids.json',
    ])).toEqual({
      overlay: 'overlays.json',
      snapshot: 'snapshot.json',
      registry: 'ids.json',
    })
  })

  test('validates overlay structure without apply validation', async () => {
    const overlayPath = join(makeTempDir(), 'overlays.json')
    await Bun.write(overlayPath, JSON.stringify({
      schemaVersion: '1.0.0',
      operations: [],
    }))

    await expect(validateCanonicalOverlays({
      overlay: overlayPath,
      registry: 'unused.json',
    })).resolves.toBeUndefined()
  })

  test('validates approved overlays against a snapshot', async () => {
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
          id: 'manual-yds_00000001-add-gloss-zh-tw-20260604',
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

    await expect(validateCanonicalOverlays({
      overlay: overlayPath,
      snapshot: snapshotPath,
      registry: registryPath,
    })).resolves.toBeUndefined()
  })

  test('fails when approved overlays do not apply', async () => {
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
          id: 'manual-yds_unknown-add-gloss-zh-tw-20260604',
          type: 'addGloss',
          sourceKind: 'manual',
          importedAt,
          reviewStatus: 'approved',
          senseId: 'yds_unknown',
          lang: 'zh-tw',
          text: '吃',
        },
      ],
    }))

    await expect(validateCanonicalOverlays({
      overlay: overlayPath,
      snapshot: snapshotPath,
      registry: registryPath,
    })).rejects.toThrow('Approved overlay apply check failed: 0 applied, 1 approved')
  })
})
