import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseArgs,
  runCurationCommand,
} from '../../scripts/pipeline/curate-canonical-overlays'
import {
  appendCanonicalOverlayOperation,
  loadCanonicalOverlayFile,
} from '../../src/domain/overlay-store'
import {
  createAiAddGlossOverlay,
  createManualAddGlossOverlay,
} from '../../src/domain/overlays'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-curate-overlays-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('canonical overlay curation CLI', () => {
  test('parses add-gloss arguments', () => {
    expect(parseArgs([
      'add-gloss',
      '--overlay', 'overlays.json',
      '--sense-id', 'yds_00000001',
      '--lang', 'zh-tw',
      '--text', '吃',
      '--imported-at', importedAt,
      '--limit', '5',
      '--approved',
    ])).toEqual({
      command: 'add-gloss',
      overlay: 'overlays.json',
      importedAt,
      id: undefined,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
      glosses: [],
      japanese: undefined,
      translation: undefined,
      limit: 5,
      approved: true,
    })
  })

  test('creates manual gloss and example operations', async () => {
    const overlay = join(makeTempDir(), 'overlays.json')

    await runCurationCommand(parseArgs([
      'replace-glosses',
      '--overlay', overlay,
      '--sense-id', 'yds_00000001',
      '--lang', 'en',
      '--gloss', 'to eat food',
      '--gloss', 'to consume',
      '--imported-at', importedAt,
      '--approved',
    ]))
    await runCurationCommand(parseArgs([
      'add-example',
      '--overlay', overlay,
      '--sense-id', 'yds_00000001',
      '--lang', 'zh-tw',
      '--japanese', '寿司を食べる。',
      '--translation', '我吃壽司。',
      '--imported-at', importedAt,
    ]))

    const file = await loadCanonicalOverlayFile(overlay)
    expect(file.operations).toHaveLength(2)
    expect(file.operations[0]).toMatchObject({
      id: 'manual-yds_00000001-replace-glosses-en-20260604',
      type: 'replaceGlosses',
      reviewStatus: 'approved',
      glosses: ['to eat food', 'to consume'],
    })
    expect(file.operations[1]).toMatchObject({
      id: 'manual-yds_00000001-add-example-zh-tw-20260604',
      type: 'addExample',
      reviewStatus: 'unreviewed',
      japanese: '寿司を食べる。',
      translation: '我吃壽司。',
    })
  })

  test('approves and rejects operations by id', async () => {
    const overlay = join(makeTempDir(), 'overlays.json')
    const operation = createManualAddGlossOverlay({
      importedAt,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })
    await appendCanonicalOverlayOperation(overlay, operation)

    await runCurationCommand(parseArgs([
      'approve',
      '--overlay', overlay,
      '--id', operation.id,
    ]))
    let file = await loadCanonicalOverlayFile(overlay)
    expect(file.operations[0].reviewStatus).toBe('approved')

    await runCurationCommand(parseArgs([
      'reject',
      '--overlay', overlay,
      '--id', operation.id,
    ]))
    file = await loadCanonicalOverlayFile(overlay)
    expect(file.operations[0].reviewStatus).toBe('rejected')
  })

  test('lists pending AI operations', async () => {
    const overlay = join(makeTempDir(), 'overlays.json')
    const ai = createAiAddGlossOverlay({
      importedAt,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      inputRefs: ['jmdict:1358280'],
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })
    const manual = createManualAddGlossOverlay({
      importedAt,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '食用',
    })
    await appendCanonicalOverlayOperation(overlay, ai)
    await appendCanonicalOverlayOperation(overlay, manual)

    const result = await runCurationCommand(parseArgs([
      'list-pending-ai',
      '--overlay', overlay,
    ]))

    expect(result).toEqual([ai])
  })

  test('filters pending AI operations by language and limit', async () => {
    const overlay = join(makeTempDir(), 'overlays.json')
    const zhTw = createAiAddGlossOverlay({
      importedAt,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      inputRefs: ['jmdict:1358280'],
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })
    const zhCn = createAiAddGlossOverlay({
      importedAt,
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'canonical-gloss-v1',
      inputRefs: ['jmdict:1358280'],
      senseId: 'yds_00000001',
      lang: 'zh-cn',
      text: '吃',
    })
    await appendCanonicalOverlayOperation(overlay, zhTw)
    await appendCanonicalOverlayOperation(overlay, zhCn)

    const result = await runCurationCommand(parseArgs([
      'list-pending-ai',
      '--overlay', overlay,
      '--lang', 'zh-tw',
      '--limit', '1',
    ]))

    expect(result).toEqual([zhTw])
  })

  test('shows one operation by id', async () => {
    const overlay = join(makeTempDir(), 'overlays.json')
    const operation = createManualAddGlossOverlay({
      importedAt,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })
    await appendCanonicalOverlayOperation(overlay, operation)

    const result = await runCurationCommand(parseArgs([
      'show',
      '--overlay', overlay,
      '--id', operation.id,
    ]))

    expect(result).toEqual(operation)
  })
})
