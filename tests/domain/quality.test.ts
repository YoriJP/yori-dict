import { describe, expect, test } from 'bun:test'
import { analyzeCanonicalQuality } from '../../src/domain/quality'
import type { CanonicalSnapshot, Entry, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-03T00:00:00.000Z'

function sourceRef(): SourceRef {
  return {
    kind: 'jmdict',
    sourceId: 'source-1',
    license: 'CC-BY-SA-4.0',
    importedAt,
  }
}

function entry(overrides: Partial<Entry> = {}): Entry {
  const refs = [sourceRef()]
  const base: Entry = {
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
    ranking: { common: true, priority: ['ichi1'] },
    sourceRefs: refs,
  }

  return { ...base, ...overrides }
}

function snapshot(entries: Entry[] = [entry()]): CanonicalSnapshot {
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    entries,
    lookupAliases: entries.map((item, index) => ({
      id: `yda_${String(index + 1).padStart(8, '0')}`,
      surface: item.primaryForm,
      normalizedSurface: item.primaryForm,
      reading: item.primaryReading,
      normalizedReading: item.primaryReading,
      entryId: item.id,
      aliasType: 'dictionary',
      score: 100,
    })),
  }
}

describe('analyzeCanonicalQuality', () => {
  test('summarizes canonical snapshot coverage', () => {
    const report = analyzeCanonicalQuality(snapshot())

    expect(report.summary.entries).toBe(1)
    expect(report.summary.senses).toBe(1)
    expect(report.summary.glosses).toBe(1)
    expect(report.summary.lookupAliases).toBe(1)
    expect(report.summary.sourceRefsByKind.jmdict).toBeGreaterThan(0)
    expect(report.summary.glossesByLanguage.en).toBe(1)
    expect(report.findings).toEqual([])
  })

  test('reports quality findings with total counts and limited samples', () => {
    const weakEntries = [
      entry({
        id: 'yde_00000001',
        primaryForm: '未訳語一',
        primaryReading: 'みやくごいち',
        readings: [],
        senses: [
          {
            ...entry().senses[0],
            id: 'yds_00000001',
            entryId: 'yde_00000001',
            partOfSpeech: [],
            glosses: [],
          },
        ],
        ranking: { common: true },
      }),
      entry({
        id: 'yde_00000002',
        primaryForm: '未訳語二',
        primaryReading: 'みやくごに',
        senses: [
          {
            ...entry().senses[0],
            id: 'yds_00000002',
            entryId: 'yde_00000002',
            glosses: [],
          },
        ],
      }),
    ]
    const report = analyzeCanonicalQuality(snapshot(weakEntries), { sampleLimit: 1 })

    const withoutGlosses = report.findings.find((finding) => finding.code === 'entries_without_glosses')
    expect(withoutGlosses?.count).toBe(2)
    expect(withoutGlosses?.samples).toHaveLength(1)

    expect(report.findings.find((finding) => finding.code === 'entries_without_readings')?.severity).toBe('error')
    expect(report.findings.find((finding) => finding.code === 'senses_without_part_of_speech')?.severity).toBe('info')
    expect(report.findings.find((finding) => finding.code === 'common_entries_missing_detailed_ranking')?.count).toBe(1)
  })

  test('reports missing target-language glosses when requested', () => {
    const report = analyzeCanonicalQuality(snapshot([entry()]), { targetLanguages: ['zh-tw'] })

    const missingTargetGlosses = report.findings.find((finding) =>
      finding.code === 'senses_missing_zh-tw_glosses'
    )
    expect(missingTargetGlosses).toMatchObject({
      severity: 'warning',
      count: 1,
    })
    expect(missingTargetGlosses?.samples[0]).toContain('missing zh-tw gloss')
  })

  test('reports duplicate aliases, collisions, and fanout', () => {
    const report = analyzeCanonicalQuality({
      ...snapshot([
        entry({ id: 'yde_00000001', primaryForm: '橋', primaryReading: 'はし' }),
        entry({ id: 'yde_00000002', primaryForm: '箸', primaryReading: 'はし' }),
        entry({ id: 'yde_00000003', primaryForm: '端', primaryReading: 'はし' }),
      ]),
      lookupAliases: [
        {
          id: 'yda_00000001',
          surface: 'はし',
          normalizedSurface: 'はし',
          reading: 'はし',
          normalizedReading: 'はし',
          entryId: 'yde_00000001',
          aliasType: 'reading',
          score: 75,
        },
        {
          id: 'yda_00000002',
          surface: 'はし',
          normalizedSurface: 'はし',
          reading: 'はし',
          normalizedReading: 'はし',
          entryId: 'yde_00000001',
          aliasType: 'reading',
          score: 75,
        },
        {
          id: 'yda_00000003',
          surface: 'はし',
          normalizedSurface: 'はし',
          reading: 'はし',
          normalizedReading: 'はし',
          entryId: 'yde_00000002',
          aliasType: 'reading',
          score: 75,
        },
        {
          id: 'yda_00000004',
          surface: 'はし',
          normalizedSurface: 'はし',
          reading: 'はし',
          normalizedReading: 'はし',
          entryId: 'yde_00000003',
          aliasType: 'reading',
          score: 75,
        },
      ],
    }, { aliasFanoutThreshold: 2 })

    expect(report.findings.find((finding) => finding.code === 'duplicate_aliases')?.count).toBe(1)
    expect(report.findings.find((finding) => finding.code === 'alias_collisions')?.count).toBe(1)
    expect(report.findings.find((finding) => finding.code === 'alias_fanout')?.count).toBe(1)
  })
})
