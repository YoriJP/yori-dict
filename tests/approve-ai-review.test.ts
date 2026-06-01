import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initUpdatesDatabase, insertExampleUpdateSet, insertTranslationUpdate, insertUpdateBatch } from '../src/update-store'
import { approvePendingAiReviews, type ApproveAiOptions } from '../scripts/review/approve-ai'

let tempDir = ''

function makeTempUpdatesPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'yori-approve-ai-'))
  return join(tempDir, 'updates.sqlite')
}

function defaultOptions(overrides: Partial<ApproveAiOptions>): ApproveAiOptions {
  return {
    all: false,
    batchId: null,
    langs: null,
    actor: 'tester',
    notes: 'test approval',
    dryRun: false,
    includeTranslations: true,
    includeExamples: true,
    ...overrides,
  }
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('bulk AI approval script', () => {
  test('dry run counts matching pending AI updates without mutating rows', () => {
    const db = initUpdatesDatabase(makeTempUpdatesPath())
    const batchId = insertUpdateBatch(db, {
      kind: 'ai_import',
      inputManifest: { test: true },
    })
    insertTranslationUpdate(db, {
      wordId: '食べる:たべる',
      lang: 'zh-tw',
      definitions: ['吃'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId,
      reviewStatus: 'pending',
    })

    const result = approvePendingAiReviews(db, defaultOptions({
      batchId,
      langs: ['zh-tw'],
      dryRun: true,
    }))

    const row = db.query<{ review_status: string }, []>(`
      SELECT review_status FROM translation_updates
    `).get()
    db.close()

    expect(result.translations).toBe(1)
    expect(result.exampleSets).toBe(0)
    expect(row?.review_status).toBe('pending')
  })

  test('approves only pending AI rows matching batch and language filters', () => {
    const db = initUpdatesDatabase(makeTempUpdatesPath())
    const targetBatch = insertUpdateBatch(db, {
      kind: 'ai_import',
      inputManifest: { name: 'target' },
    })
    const otherBatch = insertUpdateBatch(db, {
      kind: 'ai_import',
      inputManifest: { name: 'other' },
    })

    insertTranslationUpdate(db, {
      wordId: '食べる:たべる',
      lang: 'zh-tw',
      definitions: ['吃'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId: targetBatch,
      reviewStatus: 'pending',
    })
    insertExampleUpdateSet(db, {
      wordId: '食べる:たべる',
      lang: 'zh-tw',
      examples: [{ japanese: '寿司を食べる', translation: '吃壽司', source: 'ai' }],
      sourceType: 'ai',
      batchId: targetBatch,
      reviewStatus: 'pending',
    })
    insertTranslationUpdate(db, {
      wordId: '飲む:のむ',
      lang: 'ko',
      definitions: ['마시다'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId: targetBatch,
      reviewStatus: 'pending',
    })
    insertTranslationUpdate(db, {
      wordId: '見る:みる',
      lang: 'zh-tw',
      definitions: ['看'],
      sources: ['ai'],
      sourceType: 'ai',
      batchId: otherBatch,
      reviewStatus: 'pending',
    })

    const result = approvePendingAiReviews(db, defaultOptions({
      batchId: targetBatch,
      langs: ['zh-tw'],
    }))

    const rows = db.query<{ lang: string; batch_id: number; review_status: string }, []>(`
      SELECT lang, batch_id, review_status
      FROM translation_updates
      ORDER BY id
    `).all()
    const exampleRow = db.query<{ review_status: string }, []>(`
      SELECT review_status FROM example_update_sets
    `).get()
    const auditRow = db.query<{ action: string; actor: string; notes: string }, []>(`
      SELECT action, actor, notes FROM admin_actions
    `).get()
    db.close()

    expect(result.translations).toBe(1)
    expect(result.exampleSets).toBe(1)
    expect(rows).toEqual([
      { lang: 'zh-tw', batch_id: targetBatch, review_status: 'approved' },
      { lang: 'ko', batch_id: targetBatch, review_status: 'pending' },
      { lang: 'zh-tw', batch_id: otherBatch, review_status: 'pending' },
    ])
    expect(exampleRow?.review_status).toBe('approved')
    expect(auditRow?.action).toBe('review.ai.bulk-approve')
    expect(auditRow?.actor).toBe('tester')
    expect(auditRow?.notes).toContain('1 translations, 1 example sets')
  })

  test('refuses to approve without explicit all or filters', () => {
    const db = initUpdatesDatabase(makeTempUpdatesPath())

    expect(() => approvePendingAiReviews(db, defaultOptions({}))).toThrow(
      'Refusing to approve without a filter',
    )

    db.close()
  })
})
