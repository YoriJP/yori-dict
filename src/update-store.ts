import { Database } from 'bun:sqlite'
import type { ReleaseExampleRecord, ReleaseTranslationRecord, UpdateSourceType } from './storage'
import { initUpdatesDatabase, makeTranslationKey } from './storage'

export interface UpdateBatchInput {
  kind: 'source_import' | 'ai_import'
  inputManifest: Record<string, unknown>
  notes?: string | null
}

export interface TranslationUpdateInput {
  wordId: string
  lang: string
  definitions: string[]
  sources: string[]
  sourceType: UpdateSourceType
  batchId: number
}

export interface ExampleSetUpdateInput {
  wordId: string
  lang: string
  examples: Array<{
    japanese: string
    translation: string
    source: string
  }>
  sourceType: UpdateSourceType
  batchId: number
}

interface TranslationUpdateRow {
  id: number
  word_id: string
  lang: string
  definitions_json: string
  sources_json: string
  source_type: UpdateSourceType
  status: string
  created_at: string
  updated_at: string
  batch_id: number
  supersedes_update_id: number | null
}

interface ExampleUpdateSetRow {
  id: number
  word_id: string
  lang: string
  source_type: UpdateSourceType
  status: string
  created_at: string
  updated_at: string
  batch_id: number
  supersedes_set_id: number | null
}

interface ExampleUpdateRow {
  id: number
  set_id: number
  word_id: string
  lang: string
  japanese: string
  translation: string
  source: string
  source_type: UpdateSourceType
  status: string
  created_at: string
  batch_id: number
}

export interface ActiveExampleUpdate {
  setId: number
  sourceType: UpdateSourceType
  examples: ReleaseExampleRecord[]
}

export function openUpdatesDb(path?: string): Database {
  return initUpdatesDatabase(path)
}

export { initUpdatesDatabase }

export function insertUpdateBatch(db: Database, input: UpdateBatchInput): number {
  const now = new Date().toISOString()
  const stmt = db.prepare(`
    INSERT INTO update_batches (kind, created_at, input_manifest_json, notes)
    VALUES (?, ?, ?, ?)
  `)
  const result = stmt.run(
    input.kind,
    now,
    JSON.stringify(input.inputManifest),
    input.notes ?? null,
  )
  return Number(result.lastInsertRowid)
}

function getActiveTranslationUpdateRow(
  db: Database,
  wordId: string,
  lang: string
): TranslationUpdateRow | null {
  const stmt = db.query<TranslationUpdateRow, [string, string]>(`
    SELECT *
    FROM translation_updates
    WHERE word_id = ?1 AND lang = ?2 AND status = 'active'
    LIMIT 1
  `)
  return stmt.get(wordId, lang) ?? null
}

function getActiveExampleUpdateSetRow(
  db: Database,
  wordId: string,
  lang: string
): ExampleUpdateSetRow | null {
  const stmt = db.query<ExampleUpdateSetRow, [string, string]>(`
    SELECT *
    FROM example_update_sets
    WHERE word_id = ?1 AND lang = ?2 AND status = 'active'
    LIMIT 1
  `)
  return stmt.get(wordId, lang) ?? null
}

export function getActiveTranslationUpdate(
  db: Database,
  wordId: string,
  lang: string
): ReleaseTranslationRecord | null {
  const row = getActiveTranslationUpdateRow(db, wordId, lang)
  if (!row) return null
  return {
    wordId,
    lang,
    definitions: JSON.parse(row.definitions_json) as string[],
    sources: JSON.parse(row.sources_json) as string[],
  }
}

export function getActiveExampleUpdate(
  db: Database,
  wordId: string,
  lang: string
): ActiveExampleUpdate | null {
  const setRow = getActiveExampleUpdateSetRow(db, wordId, lang)
  if (!setRow) return null

  const items = db.query<ExampleUpdateRow, [number]>(`
    SELECT *
    FROM example_updates
    WHERE set_id = ?1
    ORDER BY id
  `).all(setRow.id)

  return {
    setId: setRow.id,
    sourceType: setRow.source_type,
    examples: items.map((item) => ({
      wordId: item.word_id,
      lang: item.lang,
      japanese: item.japanese,
      translation: item.translation,
      source: item.source,
    })),
  }
}

function normalizeSourceTypePriority(sourceType: UpdateSourceType): number {
  return sourceType === 'source' ? 2 : 1
}

export function insertTranslationUpdate(db: Database, input: TranslationUpdateInput): number {
  const now = new Date().toISOString()

  const run = db.transaction((payload: TranslationUpdateInput) => {
    const active = getActiveTranslationUpdateRow(db, payload.wordId, payload.lang)
    let status: 'active' | 'superseded' = 'active'
    let supersedesUpdateId: number | null = null

    if (active) {
      const existingPriority = normalizeSourceTypePriority(active.source_type)
      const incomingPriority = normalizeSourceTypePriority(payload.sourceType)

      if (incomingPriority >= existingPriority) {
        db.prepare(`
          UPDATE translation_updates
          SET status = 'superseded', updated_at = ?2
          WHERE id = ?1
        `).run(active.id, now)
        supersedesUpdateId = active.id
      } else {
        status = 'superseded'
      }
    }

    const result = db.prepare(`
      INSERT INTO translation_updates (
        word_id, lang, definitions_json, sources_json, source_type, status,
        created_at, updated_at, batch_id, supersedes_update_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.wordId,
      payload.lang,
      JSON.stringify(payload.definitions),
      JSON.stringify(payload.sources),
      payload.sourceType,
      status,
      now,
      now,
      payload.batchId,
      supersedesUpdateId,
    )

    return Number(result.lastInsertRowid)
  })

  return run(input)
}

export function insertExampleUpdateSet(db: Database, input: ExampleSetUpdateInput): number {
  const now = new Date().toISOString()

  const run = db.transaction((payload: ExampleSetUpdateInput) => {
    const activeSet = getActiveExampleUpdateSetRow(db, payload.wordId, payload.lang)
    let status: 'active' | 'superseded' = 'active'
    let supersedesSetId: number | null = null

    if (activeSet) {
      const existingPriority = normalizeSourceTypePriority(activeSet.source_type)
      const incomingPriority = normalizeSourceTypePriority(payload.sourceType)

      if (incomingPriority >= existingPriority) {
        db.prepare(`
          UPDATE example_update_sets
          SET status = 'superseded', updated_at = ?2
          WHERE id = ?1
        `).run(activeSet.id, now)
        db.prepare(`
          UPDATE example_updates
          SET status = 'superseded'
          WHERE set_id = ?1
        `).run(activeSet.id)
        supersedesSetId = activeSet.id
      } else {
        status = 'superseded'
      }
    }

    const setResult = db.prepare(`
      INSERT INTO example_update_sets (
        word_id, lang, source_type, status, created_at, updated_at, batch_id, supersedes_set_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.wordId,
      payload.lang,
      payload.sourceType,
      status,
      now,
      now,
      payload.batchId,
      supersedesSetId,
    )

    const setId = Number(setResult.lastInsertRowid)
    const insertItem = db.prepare(`
      INSERT INTO example_updates (
        set_id, word_id, lang, japanese, translation, source, source_type, status, created_at, batch_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const example of payload.examples) {
      insertItem.run(
        setId,
        payload.wordId,
        payload.lang,
        example.japanese,
        example.translation,
        example.source,
        payload.sourceType,
        status,
        now,
        payload.batchId,
      )
    }

    return setId
  })

  return run(input)
}

export function markAllActiveUpdatesPromoted(db: Database): void {
  const now = new Date().toISOString()
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE translation_updates
      SET status = 'promoted', updated_at = ?1
      WHERE status = 'active'
    `).run(now)

    db.prepare(`
      UPDATE example_update_sets
      SET status = 'promoted', updated_at = ?1
      WHERE status = 'active'
    `).run(now)

    db.prepare(`
      UPDATE example_updates
      SET status = 'promoted'
      WHERE status = 'active'
    `).run()
  })
  transaction()
}

export interface UpdateVerificationSummary {
  translationCounts: Record<string, number>
  exampleSetCounts: Record<string, number>
  orphanedWordIds: string[]
}

export function verifyUpdatesAgainstWordIds(
  db: Database,
  validWordIds: Set<string>
): UpdateVerificationSummary {
  const translationRows = db.query<{ word_id: string; status: string }, []>(`
    SELECT word_id, status FROM translation_updates
  `).all()
  const exampleSetRows = db.query<{ word_id: string; status: string }, []>(`
    SELECT word_id, status FROM example_update_sets
  `).all()

  const translationCounts: Record<string, number> = {}
  for (const row of translationRows) {
    translationCounts[row.status] = (translationCounts[row.status] || 0) + 1
  }

  const exampleSetCounts: Record<string, number> = {}
  for (const row of exampleSetRows) {
    exampleSetCounts[row.status] = (exampleSetCounts[row.status] || 0) + 1
  }

  const orphaned = new Set<string>()
  for (const row of translationRows) {
    if (!validWordIds.has(row.word_id)) orphaned.add(row.word_id)
  }
  for (const row of exampleSetRows) {
    if (!validWordIds.has(row.word_id)) orphaned.add(row.word_id)
  }

  return {
    translationCounts,
    exampleSetCounts,
    orphanedWordIds: [...orphaned].sort(),
  }
}

export function buildTranslationMapFromUpdates(
  db: Database,
  sourceType?: UpdateSourceType
): Map<string, ReleaseTranslationRecord> {
  const map = new Map<string, ReleaseTranslationRecord>()
  const rows = sourceType
    ? db.query<TranslationUpdateRow, [UpdateSourceType]>(`
        SELECT *
        FROM translation_updates
        WHERE status = 'active' AND source_type = ?1
      `).all(sourceType)
    : db.query<TranslationUpdateRow, []>(`
        SELECT *
        FROM translation_updates
        WHERE status = 'active'
      `).all()

  for (const row of rows) {
    map.set(makeTranslationKey(row.word_id, row.lang), {
      wordId: row.word_id,
      lang: row.lang,
      definitions: JSON.parse(row.definitions_json) as string[],
      sources: JSON.parse(row.sources_json) as string[],
    })
  }

  return map
}

export function buildExampleMapFromUpdates(
  db: Database,
  sourceType?: UpdateSourceType
): Map<string, ReleaseExampleRecord[]> {
  const map = new Map<string, ReleaseExampleRecord[]>()
  const sets = sourceType
    ? db.query<ExampleUpdateSetRow, [UpdateSourceType]>(`
        SELECT *
        FROM example_update_sets
        WHERE status = 'active' AND source_type = ?1
      `).all(sourceType)
    : db.query<ExampleUpdateSetRow, []>(`
        SELECT *
        FROM example_update_sets
        WHERE status = 'active'
      `).all()

  const queryItems = db.query<ExampleUpdateRow, [number]>(`
    SELECT *
    FROM example_updates
    WHERE set_id = ?1
    ORDER BY id
  `)

  for (const setRow of sets) {
    const items = queryItems.all(setRow.id)
    map.set(
      makeTranslationKey(setRow.word_id, setRow.lang),
      items.map((item) => ({
        wordId: item.word_id,
        lang: item.lang,
        japanese: item.japanese,
        translation: item.translation,
        source: item.source,
      }))
    )
  }

  return map
}
