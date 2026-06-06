import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendCanonicalOverlayOperation,
  getCanonicalOverlayOperation,
  listCanonicalOverlayOperations,
  listPendingAiOverlayOperations,
  loadCanonicalOverlayFile,
  updateCanonicalOverlayOperation,
} from '../../src/domain/overlay-store'
import {
  approveOverlayOperation,
  createAiAddGlossOverlay,
  createManualAddGlossOverlay,
} from '../../src/domain/overlays'

const tempDirs: string[] = []
const importedAt = '2026-06-04T00:00:00.000Z'

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yori-overlay-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('canonical overlay store', () => {
  test('loads a missing overlay file as an empty file', async () => {
    const file = await loadCanonicalOverlayFile(join(makeTempDir(), 'overlays.json'))
    expect(file).toEqual({
      schemaVersion: '1.0.0',
      operations: [],
    })
  })

  test('appends operations and rejects duplicate operation ids', async () => {
    const path = join(makeTempDir(), 'overlays.json')
    const operation = createManualAddGlossOverlay({
      importedAt,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })

    const file = await appendCanonicalOverlayOperation(path, operation)
    expect(file.operations).toHaveLength(1)
    expect(file.operations[0]).toEqual(operation)

    await expect(appendCanonicalOverlayOperation(path, operation))
      .rejects.toThrow(`Overlay operation already exists: ${operation.id}`)
  })

  test('updates one operation by id and validates the saved file', async () => {
    const path = join(makeTempDir(), 'overlays.json')
    const operation = createManualAddGlossOverlay({
      importedAt,
      senseId: 'yds_00000001',
      lang: 'zh-tw',
      text: '吃',
    })
    await appendCanonicalOverlayOperation(path, operation)

    const updated = await updateCanonicalOverlayOperation(path, operation.id, approveOverlayOperation)
    expect(updated.reviewStatus).toBe('approved')

    const file = await loadCanonicalOverlayFile(path)
    expect(file.operations[0].reviewStatus).toBe('approved')
  })

  test('lists pending AI operations only', async () => {
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

    expect(listPendingAiOverlayOperations({
      schemaVersion: '1.0.0',
      operations: [ai, manual, approveOverlayOperation(ai)],
    })).toEqual([ai])
  })

  test('lists and finds operations with filters', async () => {
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
      lang: 'zh-cn',
      text: '吃',
    })
    const file = {
      schemaVersion: '1.0.0' as const,
      operations: [ai, manual],
    }

    expect(getCanonicalOverlayOperation(file, ai.id)).toEqual(ai)
    expect(listCanonicalOverlayOperations(file, {
      sourceKind: 'ai',
      reviewStatus: 'unreviewed',
      lang: 'zh-tw',
      limit: 1,
    })).toEqual([ai])
  })
})
