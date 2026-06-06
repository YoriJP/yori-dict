import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  generateGeminiGlossSuggestion,
  parseArgs,
  parseModelSuggestion,
  runGenerateAiCurationSuggestions,
} from '../../scripts/pipeline/generate-ai-curation-suggestions'
import type { CurationQueue } from '../../src/domain/curation-queue'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-ai-suggestions-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.GEMINI_API_KEY
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
      itemCount: 2,
      totalCandidateCount: 2,
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
        inputRefs: ['entry:yde_00000001', 'sense:yds_00000001'],
      },
      {
        id: 'missingGloss-yds_00000002-zh-tw',
        type: 'missingGloss',
        priority: 90,
        targetLang: 'zh-tw',
        entryId: 'yde_00000002',
        senseId: 'yds_00000002',
        primaryForm: '飲む',
        primaryReading: 'のむ',
        senseOrder: 1,
        partOfSpeech: ['v5m'],
        reason: 'Missing approved zh-tw gloss',
        sourceGlosses: [{ lang: 'en', text: 'to drink', sourceType: 'source' }],
        inputRefs: ['entry:yde_00000002', 'sense:yds_00000002'],
      },
    ],
  }
}

describe('AI curation suggestion generator CLI', () => {
  test('parses CLI arguments', () => {
    expect(parseArgs([
      '--queue', 'queue.json',
      '--out', 'suggestions.jsonl',
      '--model', 'gemini-3.1-flash-lite',
      '--prompt-version', 'canonical-gloss-v1',
      '--api-key-env', 'TEST_GEMINI_KEY',
      '--api-base', 'https://example.test',
      '--limit', '10',
      '--overwrite',
    ])).toEqual({
      queue: 'queue.json',
      out: 'suggestions.jsonl',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      apiKeyEnv: 'TEST_GEMINI_KEY',
      apiBase: 'https://example.test',
      limit: 10,
      overwrite: true,
    })
  })

  test('parses fenced JSON model output', () => {
    expect(parseModelSuggestion('```json\n{"text":"吃"}\n```')).toBe('吃')
  })

  test('writes suggestion JSONL from curation queue items', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const outPath = join(dir, 'suggestions.jsonl')
    process.env.GEMINI_API_KEY = 'test-key'
    await Bun.write(queuePath, JSON.stringify(queue()))

    const suggestions = await runGenerateAiCurationSuggestions({
      queue: queuePath,
      out: outPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      apiKeyEnv: 'GEMINI_API_KEY',
      apiBase: 'https://example.test',
      limit: 1,
      overwrite: false,
    }, async ({ item }) => ({
      queueItemId: item.id,
      text: item.primaryForm === '食べる' ? '吃' : '喝',
    }))

    expect(suggestions).toEqual([
      { queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '吃' },
    ])
    expect(await Bun.file(outPath).text()).toBe(
      JSON.stringify({ queueItemId: 'missingGloss-yds_00000001-zh-tw', text: '吃' }) + '\n'
    )
  })

  test('refuses to overwrite existing suggestion output by default', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const outPath = join(dir, 'suggestions.jsonl')
    process.env.GEMINI_API_KEY = 'test-key'
    await Bun.write(queuePath, JSON.stringify(queue()))
    await Bun.write(outPath, 'existing\n')
    let calls = 0

    await expect(runGenerateAiCurationSuggestions({
      queue: queuePath,
      out: outPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      apiKeyEnv: 'GEMINI_API_KEY',
      apiBase: 'https://example.test',
      overwrite: false,
    }, async ({ item }) => {
      calls++
      return { queueItemId: item.id, text: '吃' }
    })).rejects.toThrow(`Output already exists: ${outPath}`)

    expect(calls).toBe(0)
    expect(await Bun.file(outPath).text()).toBe('existing\n')
  })

  test('does not write partial suggestions when generation fails', async () => {
    const dir = makeTempDir()
    const queuePath = join(dir, 'queue.json')
    const outPath = join(dir, 'suggestions.jsonl')
    process.env.GEMINI_API_KEY = 'test-key'
    await Bun.write(queuePath, JSON.stringify(queue()))

    await expect(runGenerateAiCurationSuggestions({
      queue: queuePath,
      out: outPath,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      apiKeyEnv: 'GEMINI_API_KEY',
      apiBase: 'https://example.test',
      overwrite: false,
    }, async ({ item }) => {
      if (item.id === 'missingGloss-yds_00000002-zh-tw') {
        throw new Error('quota exhausted')
      }
      return { queueItemId: item.id, text: '吃' }
    })).rejects.toThrow('AI suggestion failed for missingGloss-yds_00000002-zh-tw: quota exhausted')

    expect(existsSync(outPath)).toBe(false)
  })

  test('reports Gemini quota and rate-limit failures clearly', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () => new Response('quota exhausted', { status: 429 }),
      { preconnect: originalFetch.preconnect }
    )

    try {
      await expect(generateGeminiGlossSuggestion({
        item: queue().items[0],
        model: 'gemini-3.1-flash-lite',
        promptVersion: 'canonical-gloss-v1',
        apiKey: 'test-key',
        apiBase: 'https://example.test',
      })).rejects.toThrow('Gemini quota or rate limit exceeded (429): quota exhausted')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
