import { describe, expect, test } from 'bun:test'
import { buildCurationQueue } from '../../src/domain/curation-queue'
import type { CanonicalSnapshot, Entry, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-04T00:00:00.000Z'

function sourceRef(sourceId = '1358280'): SourceRef {
  return {
    kind: 'jmdict',
    sourceId,
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
    ranking: { common: true, frequency: 100 },
    sourceRefs: refs,
  }
  return { ...base, ...overrides }
}

function snapshot(entries: Entry[]): CanonicalSnapshot {
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    entries,
    lookupAliases: [],
  }
}

describe('buildCurationQueue', () => {
  test('queues senses missing a target-language gloss', () => {
    const queue = buildCurationQueue(snapshot([entry()]), { targetLang: 'zh-tw' })

    expect(queue.targetLang).toBe('zh-tw')
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0]).toMatchObject({
      id: 'missingGloss-yds_00000001-zh-tw',
      type: 'missingGloss',
      entryId: 'yde_00000001',
      senseId: 'yds_00000001',
      primaryForm: '食べる',
      sourceGlosses: [{ lang: 'en', text: 'to eat', sourceType: 'source' }],
    })
    expect(queue.items[0].inputRefs).toContain('jmdict:1358280')
  })

  test('skips senses that already have an approved target-language gloss', () => {
    const base = entry()
    base.senses[0].glosses.push({
      id: 'ydg_00000002',
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
      sourceType: 'manual',
      reviewStatus: 'approved',
      sourceRefs: [{ kind: 'manual', sourceId: 'manual-1', importedAt }],
    })

    expect(buildCurationQueue(snapshot([base]), { targetLang: 'zh-tw' }).items).toEqual([])
  })

  test('orders common entries first and respects common-only', () => {
    const uncommon = entry({
      id: 'yde_00000002',
      primaryForm: '稀語',
      primaryReading: 'まれご',
      ranking: { common: false },
      senses: [
        {
          ...entry().senses[0],
          id: 'yds_00000002',
          entryId: 'yde_00000002',
        },
      ],
    })

    const queue = buildCurationQueue(snapshot([uncommon, entry()]), {
      targetLang: 'zh-tw',
      commonOnly: true,
    })

    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].entryId).toBe('yde_00000001')
  })
})
