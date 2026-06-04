import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  writeCanonicalReleaseManifest,
} from '../../scripts/pipeline/write-canonical-release-manifest'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-release-manifest-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

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
    lookupAliases: [
      {
        id: 'yda_00000001',
        surface: '食べる',
        normalizedSurface: '食べる',
        entryId: 'yde_00000001',
        aliasType: 'dictionary',
        score: 100,
      },
    ],
  }
}

describe('canonical release manifest CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--snapshot', 'snapshot.json',
      '--release-db', 'release.sqlite',
      '--overlay', 'overlays.json',
      '--quality-report', 'quality.json',
      '--source', 'jmdict=JMdict_e.xml',
      '--out', 'manifest.json',
      '--generated-at', importedAt,
      '--release-version', '2026.06.04',
    ])).toEqual({
      snapshot: 'snapshot.json',
      releaseDb: 'release.sqlite',
      overlays: ['overlays.json'],
      qualityReport: 'quality.json',
      sources: [{ kind: 'jmdict', path: 'JMdict_e.xml' }],
      out: 'manifest.json',
      generatedAt: importedAt,
      releaseVersion: '2026.06.04',
    })
  })

  test('writes release artifact hashes and snapshot summary', async () => {
    const dir = makeTempDir()
    const snapshotPath = join(dir, 'snapshot.json')
    const releaseDbPath = join(dir, 'release.sqlite')
    const overlayPath = join(dir, 'overlays.json')
    const qualityReportPath = join(dir, 'quality.json')
    const sourcePath = join(dir, 'JMdict_e.xml')
    const outPath = join(dir, 'manifest.json')
    const snapshotJson = JSON.stringify(snapshot())
    const releaseDbContent = 'sqlite-content'
    const overlayContent = '{"schemaVersion":"1.0.0","operations":[]}'
    const qualityContent = '{"summary":{"entries":1}}'
    const sourceContent = '<JMdict/>'

    await Bun.write(snapshotPath, snapshotJson)
    await Bun.write(releaseDbPath, releaseDbContent)
    await Bun.write(overlayPath, overlayContent)
    await Bun.write(qualityReportPath, qualityContent)
    await Bun.write(sourcePath, sourceContent)

    const manifest = await writeCanonicalReleaseManifest({
      snapshot: snapshotPath,
      releaseDb: releaseDbPath,
      overlays: [overlayPath],
      qualityReport: qualityReportPath,
      sources: [{ kind: 'jmdict', path: sourcePath }],
      out: outPath,
      generatedAt: importedAt,
      releaseVersion: '2026.06.04',
    })

    expect(manifest).toMatchObject({
      schemaVersion: '1.0.0',
      generatedAt: importedAt,
      releaseVersion: '2026.06.04',
      summary: {
        entries: 1,
        lookupAliases: 1,
        kanjiCharacters: 0,
      },
    })
    expect(manifest.artifacts.snapshot).toEqual({
      path: snapshotPath,
      sha256: sha256(snapshotJson),
      bytes: Buffer.byteLength(snapshotJson),
    })
    expect(manifest.artifacts.releaseDb).toMatchObject({
      path: releaseDbPath,
      sha256: sha256(releaseDbContent),
      bytes: Buffer.byteLength(releaseDbContent),
    })
    expect(manifest.artifacts.overlays[0]).toMatchObject({
      path: overlayPath,
      sha256: sha256(overlayContent),
    })
    expect(manifest.artifacts.qualityReport).toMatchObject({
      path: qualityReportPath,
      sha256: sha256(qualityContent),
    })
    expect(manifest.artifacts.sources[0]).toMatchObject({
      kind: 'jmdict',
      path: sourcePath,
      sha256: sha256(sourceContent),
    })

    const written = await Bun.file(outPath).json()
    expect(written).toEqual(manifest)
  })

  test('requires provided artifacts to exist', async () => {
    const dir = makeTempDir()
    await expect(writeCanonicalReleaseManifest({
      snapshot: join(dir, 'missing-snapshot.json'),
      releaseDb: join(dir, 'release.sqlite'),
      overlays: [],
      sources: [],
      out: join(dir, 'manifest.json'),
      generatedAt: importedAt,
    })).rejects.toThrow('Artifact not found')
  })
})
