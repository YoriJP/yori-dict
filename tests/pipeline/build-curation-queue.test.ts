import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  runBuildCurationQueue,
} from '../../scripts/pipeline/build-curation-queue'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-curation-queue-'))
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
        forms: [],
        readings: [],
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
    lookupAliases: [],
  }
}

describe('canonical curation queue CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--lang', 'zh-tw',
      '--out', 'queue.json',
      '--limit', '5',
      '--common-only',
    ])).toEqual({
      snapshot: 'snapshot.json',
      lang: 'zh-tw',
      out: 'queue.json',
      limit: 5,
      commonOnly: true,
    })
  })

  test('writes a queue file from a canonical snapshot', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const outPath = join(dir, 'queue.json')
    await Bun.write(snapshotPath, JSON.stringify(snapshot()))

    const queue = await runBuildCurationQueue({
      snapshot: snapshotPath,
      lang: 'zh-tw',
      out: outPath,
      commonOnly: false,
    })

    expect(queue.items).toHaveLength(1)
    const saved = await Bun.file(outPath).json()
    expect(saved.items[0]).toMatchObject({
      id: 'missingGloss-yds_00000001-zh-tw',
      entryId: 'yde_00000001',
      senseId: 'yds_00000001',
    })
  })
})
