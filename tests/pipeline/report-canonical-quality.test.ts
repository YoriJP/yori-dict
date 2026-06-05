import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  reportCanonicalQuality,
} from '../../scripts/pipeline/report-canonical-quality'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-03T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-quality-report-'))
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
            partOfSpeech: [],
            appliesToFormIds: 'all',
            appliesToReadingIds: 'all',
            domain: [],
            register: [],
            misc: [],
            glosses: [],
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

describe('canonical quality report CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--json-out', 'report.json',
      '--fail-on', 'warning',
      '--alias-fanout-threshold', '5',
      '--sample-limit', '3',
    ])).toEqual({
      snapshot: 'snapshot.json',
      jsonOut: 'report.json',
      failOn: 'warning',
      aliasFanoutThreshold: 5,
      sampleLimit: 3,
    })
  })

  test('writes a JSON quality report', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const reportPath = join(dir, 'quality.json')
    await Bun.write(snapshotPath, JSON.stringify(snapshot()))

    const report = await reportCanonicalQuality({
      snapshot: snapshotPath,
      jsonOut: reportPath,
      failOn: 'none',
      aliasFanoutThreshold: 20,
      sampleLimit: 10,
    })

    expect(report.findings.find((finding) => finding.code === 'entries_without_glosses')?.count).toBe(1)
    expect(existsSync(reportPath)).toBe(true)
    const written = await Bun.file(reportPath).json()
    expect(written.summary.entries).toBe(1)
    expect(written.findings.some((finding: { code: string }) => finding.code === 'senses_without_part_of_speech')).toBe(true)
  })
})
