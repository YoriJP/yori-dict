import { describe, expect, test } from 'bun:test'
import { createEmptyIdRegistry } from '../../src/domain/ids'
import {
  applyCanonicalOverlayFile,
  validateCanonicalOverlayFile,
  type CanonicalOverlayFile,
} from '../../src/domain/overlays'
import type { CanonicalSnapshot, SourceRef } from '../../src/domain/types'

const importedAt = '2026-06-04T00:00:00.000Z'

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

function registry() {
  const registry = createEmptyIdRegistry()
  registry.next.glosses = 2
  registry.next.examples = 1
  return registry
}

describe('canonical overlays', () => {
  test('adds approved manual glosses and examples', () => {
    const result = applyCanonicalOverlayFile(snapshot(), {
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
        {
          id: 'manual-example-1',
          type: 'addExample',
          sourceKind: 'manual',
          importedAt,
          reviewStatus: 'approved',
          senseId: 'yds_00000001',
          lang: 'zh-tw',
          japanese: '寿司を食べる。',
          translation: '我吃壽司。',
        },
      ],
    }, { registry: registry() })

    const sense = result.snapshot.entries[0].senses[0]
    expect(result.stats).toMatchObject({
      operationsProcessed: 2,
      operationsApplied: 2,
      glossesAdded: 1,
      examplesAdded: 1,
    })
    expect(sense.glosses[1]).toMatchObject({
      id: 'ydg_00000002',
      lang: 'zh-tw',
      text: '吃',
      sourceType: 'manual',
      reviewStatus: 'approved',
      sourceRefs: [{ kind: 'manual', sourceId: 'manual-gloss-1' }],
    })
    expect(sense.examples[0]).toMatchObject({
      id: 'ydx_00000001',
      lang: 'zh-tw',
      japanese: '寿司を食べる。',
      translation: '我吃壽司。',
      sourceRefs: [{ kind: 'manual', sourceId: 'manual-example-1' }],
    })
  })

  test('replaces same-language source glosses with approved manual glosses', () => {
    const result = applyCanonicalOverlayFile(snapshot(), {
      schemaVersion: '1.0.0',
      operations: [
        {
          id: 'manual-replace-en',
          type: 'replaceGlosses',
          sourceKind: 'manual',
          importedAt,
          reviewStatus: 'approved',
          senseId: 'yds_00000001',
          lang: 'en',
          glosses: ['to eat food'],
        },
      ],
    }, { registry: createEmptyIdRegistry() })

    expect(result.snapshot.entries[0].senses[0].glosses).toEqual([
      {
        id: 'ydg_00000001',
        senseId: 'yds_00000001',
        lang: 'en',
        text: 'to eat food',
        sourceType: 'manual',
        reviewStatus: 'approved',
        sourceRefs: [
          {
            kind: 'manual',
            sourceId: 'manual-replace-en',
            importedAt,
            reviewStatus: 'approved',
          },
        ],
      },
    ])
  })

  test('skips unapproved AI operations but validates AI metadata', () => {
    const overlay: CanonicalOverlayFile = {
      schemaVersion: '1.0.0',
      operations: [
        {
          id: 'ai-gloss-1',
          type: 'addGloss',
          sourceKind: 'ai',
          importedAt,
          reviewStatus: 'unreviewed',
          model: 'gemini-3.1-flash-lite',
          promptVersion: 'canonical-gloss-v1',
          inputRefs: ['jmdict:1358280'],
          senseId: 'yds_00000001',
          lang: 'zh-tw',
          text: '吃',
        },
      ],
    }

    expect(validateCanonicalOverlayFile(overlay).valid).toBe(true)
    const result = applyCanonicalOverlayFile(snapshot(), overlay, { registry: registry() })
    expect(result.stats).toMatchObject({
      operationsProcessed: 1,
      operationsApplied: 0,
      operationsSkipped: 1,
    })
    expect(result.snapshot.entries[0].senses[0].glosses).toHaveLength(1)
  })

  test('requires AI model, prompt version, and input refs', () => {
    const result = validateCanonicalOverlayFile({
      schemaVersion: '1.0.0',
      operations: [
        {
          id: 'ai-gloss-1',
          type: 'addGloss',
          sourceKind: 'ai',
          importedAt,
          reviewStatus: 'approved',
          senseId: 'yds_00000001',
          lang: 'zh-tw',
          text: '吃',
        },
      ],
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.path)).toEqual([
      'operations[0].model',
      'operations[0].promptVersion',
      'operations[0].inputRefs',
    ])
  })

  test('rejects malformed overlay payloads', () => {
    expect(validateCanonicalOverlayFile(null).errors).toEqual([
      { path: 'overlay', message: 'overlay file must be an object' },
    ])
    expect(validateCanonicalOverlayFile({
      schemaVersion: '1.0.0',
      operations: [null],
    }).errors).toEqual([
      { path: 'operations[0]', message: 'operation must be an object' },
    ])
  })
})
