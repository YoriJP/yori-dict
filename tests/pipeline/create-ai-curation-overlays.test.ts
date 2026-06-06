import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  runCreateAiCurationOverlays,
} from '../../scripts/pipeline/create-ai-curation-overlays'
import { loadCanonicalOverlayFile } from '../../src/domain/overlay-store'
import type { CurationQueue } from '../../src/domain/curation-queue'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-ai-curation-overlays-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function queue(): CurationQueue {
  return {
    schemaVersion: '1.0.0',
    generatedAt: importedAt,
    snapshotGeneratedAt: importedAt,
    targetLang: 'zh-tw',
    summary: {
      itemCount: 1,
      totalCandidateCount: 1,
      filters: {
        commonOnly: false,
      },
    },
    items: [
      {
        id: 'missingGloss-yds_00000001-zh-tw',
        type: 'missingGloss',
        priority: 100,
        targetLang: 'zh-tw',
        entryId: 'yde_00000001',
        senseId: 'yds_00000001',
        primaryForm: '食べる',
        primaryReading: 'たべる',
        senseOrder: 1,
        partOfSpeech: ['v1'],
        reason: 'Missing approved zh-tw gloss',
        sourceGlosses: [{ lang: 'en', text: 'to eat', sourceType: 'source' }],
        inputRefs: ['entry:yde_00000001', 'sense:yds_00000001', 'jmdict:1358280'],
      },
    ],
  }
}

function queueWithTwoItems(): CurationQueue {
  const result = queue()
  result.items.push({
    ...result.items[0],
    id: 'missingGloss-yds_00000002-zh-tw',
    entryId: 'yde_00000002',
    senseId: 'yds_00000002',
    primaryForm: '飲む',
    primaryReading: 'のむ',
    inputRefs: ['entry:yde_00000002', 'sense:yds_00000002', 'jmdict:1358290'],
  })
  result.summary = {
    ...result.summary,
    itemCount: 2,
    totalCandidateCount: 2,
  }
  return result
}

describe('AI curation overlay suggestion CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--queue', 'queue.json',
      '--suggestions', 'suggestions.json',
      '--overlay', 'overlays.json',
      '--model', 'gemini-3.1-flash-lite',
      '--prompt-version', 'canonical-gloss-v1',
      '--imported-at', importedAt,
      '--limit', '10',
    ])).toEqual({
      queue: 'queue.json',
      suggestions: 'suggestions.json',
      overlay: 'overlays.json',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
      limit: 10,
    })
  })

  test('creates unreviewed AI overlay operations from suggestions', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.jsonl')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(suggestionsPath, JSON.stringify({
      queueItemId: 'missingGloss-yds_00000001-zh-tw',
      text: '吃',
    }) + '\n')

    const operations = await runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })

    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      id: 'ai-yds_00000001-add-gloss-zh-tw-canonical-gloss-v1-20260604',
      type: 'addGloss',
      sourceKind: 'ai',
      reviewStatus: 'unreviewed',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      inputRefs: ['entry:yde_00000001', 'sense:yds_00000001', 'jmdict:1358280'],
      text: '吃',
    })

    const overlay = await loadCanonicalOverlayFile(overlayPath)
    expect(overlay.operations).toEqual(operations)
  })

  test('accepts JSONL suggestion files', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.jsonl')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(suggestionsPath, [
      JSON.stringify({ queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '食べること' }),
      '',
    ].join('\n'))

    const operations = await runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })

    expect(operations[0]).toMatchObject({
      text: '食べること',
      reviewStatus: 'unreviewed',
    })
  })

  test('rejects duplicate suggestion queue item ids', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.json')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(suggestionsPath, JSON.stringify([
      { queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '吃' },
      { queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '食べること' },
    ]))

    await expect(runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })).rejects.toThrow('Duplicate suggestion queueItemId: missingGloss-yds_00000001-zh-tw')
    expect(existsSync(overlayPath)).toBe(false)
  })

  test('rejects suggestions that do not match queue items', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.jsonl')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(suggestionsPath, JSON.stringify({ queueItemId: 'missingGloss-unknown-zh-tw', text: '未使用' }))

    await expect(runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })).rejects.toThrow('Suggestions do not match queue items: missingGloss-unknown-zh-tw')
    expect(existsSync(overlayPath)).toBe(false)
  })

  test('rejects existing pending AI operations for the same target', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.json')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(suggestionsPath, JSON.stringify([
      { queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '吃' },
    ]))
    await Bun.write(overlayPath, JSON.stringify({
      schemaVersion: '1.0.0',
      operations: [
        {
          id: 'ai-yds_00000001-add-gloss-zh-tw-canonical-gloss-v1-20260603',
          type: 'addGloss',
          sourceKind: 'ai',
          importedAt: '2026-06-03T00:00:00.000Z',
          reviewStatus: 'unreviewed',
          model: 'gemini-3.1-flash-lite',
          promptVersion: 'canonical-gloss-v1',
          inputRefs: ['entry:yde_00000001'],
          senseId: 'yds_00000001',
          lang: 'zh-tw',
          text: '吃',
        },
      ],
    }))

    await expect(runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })).rejects.toThrow('Pending AI overlay already exists for addGloss:yds_00000001:zh-tw:canonical-gloss-v1')
  })

  test('does not partially write when a duplicate operation is found', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const suggestionsPath = join(dir, 'suggestions.json')
    const overlayPath = join(dir, 'overlays.json')
    await Bun.write(queuePath, JSON.stringify(queueWithTwoItems()))
    await Bun.write(suggestionsPath, JSON.stringify([
      { queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '吃' },
      { queueItemId: 'missingGloss-yds_00000002-zh-tw', text: '喝' },
    ]))
    await Bun.write(overlayPath, JSON.stringify({
      schemaVersion: '1.0.0',
      operations: [
        {
          id: 'ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604',
          type: 'addGloss',
          sourceKind: 'ai',
          importedAt,
          reviewStatus: 'rejected',
          model: 'gemini-3.1-flash-lite',
          promptVersion: 'canonical-gloss-v1',
          inputRefs: ['entry:yde_00000002'],
          senseId: 'yds_00000002',
          lang: 'zh-tw',
          text: '喝',
        },
      ],
    }))

    await expect(runCreateAiCurationOverlays({
      queue: queuePath,
      suggestions: suggestionsPath,
      overlay: overlayPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      importedAt,
    })).rejects.toThrow('Overlay operation already exists: ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604')

    const overlay = await loadCanonicalOverlayFile(overlayPath)
    expect(overlay.operations).toHaveLength(1)
    expect(overlay.operations[0].id).toBe('ai-yds_00000002-add-gloss-zh-tw-canonical-gloss-v1-20260604')
  })
})
