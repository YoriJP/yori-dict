import { Database } from 'bun:sqlite'
import type {
  ReleaseExampleRecord,
  ReleaseTranslationRecord,
  ReviewStatus,
  UpdateBatchStatus,
  UpdateSourceType,
} from './storage'
import { initUpdatesDatabase, makeTranslationKey } from './storage'

export interface UpdateBatchInput {
  kind: 'source_import' | 'ai_import'
  inputManifest: Record<string, unknown>
  notes?: string | null
  actor?: string | null
}

export interface TranslationUpdateInput {
  wordId: string
  lang: string
  definitions: string[]
  sources: string[]
  sourceType: UpdateSourceType
  batchId: number
  reviewStatus?: ReviewStatus
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
  reviewStatus?: ReviewStatus
}

export interface UpdateBatchRecord {
  id: number
  kind: 'source_import' | 'ai_import'
  createdAt: string
  inputManifest: Record<string, unknown>
  notes: string | null
  status: UpdateBatchStatus
  completedAt: string | null
  errorMessage: string | null
  actor: string | null
}

export interface AdminActionInput {
  actor: string
  action: string
  targetKind: string
  targetId: string
  notes?: string | null
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
  review_status: ReviewStatus
  reviewed_at: string | null
  reviewed_by: string | null
  review_notes: string | null
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
  review_status: ReviewStatus
  reviewed_at: string | null
  reviewed_by: string | null
  review_notes: string | null
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

interface UpdateBatchRow {
  id: number
  kind: 'source_import' | 'ai_import'
  created_at: string
  input_manifest_json: string
  notes: string | null
  status: UpdateBatchStatus
  completed_at: string | null
  error_message: string | null
  actor: string | null
}

export interface ReviewMetadata {
  reviewStatus: ReviewStatus
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNotes: string | null
}

export interface DetailedTranslationUpdate extends ReviewMetadata {
  id: number
  wordId: string
  lang: string
  definitions: string[]
  sources: string[]
  sourceType: UpdateSourceType
  status: string
  createdAt: string
  updatedAt: string
  batchId: number
  supersedesUpdateId: number | null
}

export interface DetailedExampleUpdateSet extends ReviewMetadata {
  id: number
  wordId: string
  lang: string
  sourceType: UpdateSourceType
  status: string
  createdAt: string
  updatedAt: string
  batchId: number
  supersedesSetId: number | null
  examples: ReleaseExampleRecord[]
}

export interface ActiveExampleUpdate {
  setId: number
  sourceType: UpdateSourceType
  reviewStatus: ReviewStatus
  examples: ReleaseExampleRecord[]
}

export interface UpdateVerificationSummary {
  translationCounts: Record<string, number>
  exampleSetCounts: Record<string, number>
  reviewCounts: Record<string, number>
  orphanedWordIds: string[]
  activeReviewedAiCount: number
}

export interface UpdateListFilters {
  lang?: string | null
  sourceType?: UpdateSourceType | null
  status?: string | null
  reviewStatus?: ReviewStatus | null
  batchId?: number | null
  limit?: number
}

export interface ListedTranslationUpdate extends DetailedTranslationUpdate {
  batch: UpdateBatchRecord | null
}

export interface ListedExampleUpdateSet extends DetailedExampleUpdateSet {
  batch: UpdateBatchRecord | null
}

export interface PendingReviewUnitKey {
  unitId: string
  wordId: string
  lang: string
  batchId: number
}

export interface PendingReviewUnitKeyFilters {
  batchId?: number | null
  lang?: string | null
}

export interface PendingReviewUnitKeyPage extends PendingReviewUnitKey {
  translationId: number | null
  exampleSetId: number | null
}

export interface PendingReviewUnitKeyPageResult {
  items: PendingReviewUnitKeyPage[]
  nextCursor: string | null
}

export interface BulkReviewStatusInput {
  translationIds: number[]
  exampleSetIds: number[]
  reviewStatus: Extract<ReviewStatus, 'approved' | 'rejected'>
  actor: string
  notes?: string | null
}

export interface BulkReviewStatusResult {
  translationIds: number[]
  exampleSetIds: number[]
}

function defaultReviewStatus(sourceType: UpdateSourceType): ReviewStatus {
  return sourceType === 'ai' ? 'pending' : 'not_required'
}

function normalizeSourceTypePriority(sourceType: UpdateSourceType): number {
  return sourceType === 'source' ? 2 : 1
}

function isReviewEffective(sourceType: UpdateSourceType, reviewStatus: ReviewStatus): boolean {
  return sourceType === 'source' || reviewStatus === 'approved'
}

function encodePendingReviewUnitId(wordId: string, lang: string, batchId: number): string {
  return `${wordId}|${lang}|${batchId}`
}

function comparePendingReviewUnitOrder(
  left: Pick<PendingReviewUnitKey, 'batchId' | 'wordId' | 'lang'>,
  right: Pick<PendingReviewUnitKey, 'batchId' | 'wordId' | 'lang'>
): number {
  if (left.batchId !== right.batchId) return right.batchId - left.batchId
  if (left.wordId !== right.wordId) return left.wordId.localeCompare(right.wordId)
  return left.lang.localeCompare(right.lang)
}

function parsePendingReviewCursor(cursor: string): PendingReviewUnitKey | null {
  const [wordId, lang, batchIdRaw] = cursor.split('|')
  const batchId = Number(batchIdRaw)
  if (!wordId || !lang || !Number.isFinite(batchId)) return null
  return {
    unitId: encodePendingReviewUnitId(wordId, lang, batchId),
    wordId,
    lang,
    batchId,
  }
}

function buildPendingReviewUnitKeyMap(
  translations: DetailedTranslationUpdate[],
  exampleSets: DetailedExampleUpdateSet[]
): Map<string, PendingReviewUnitKeyPage> {
  const map = new Map<string, PendingReviewUnitKeyPage>()

  for (const item of translations) {
    const unitId = encodePendingReviewUnitId(item.wordId, item.lang, item.batchId)
    map.set(unitId, {
      unitId,
      wordId: item.wordId,
      lang: item.lang,
      batchId: item.batchId,
      translationId: item.id,
      exampleSetId: map.get(unitId)?.exampleSetId ?? null,
    })
  }

  for (const item of exampleSets) {
    const unitId = encodePendingReviewUnitId(item.wordId, item.lang, item.batchId)
    map.set(unitId, {
      unitId,
      wordId: item.wordId,
      lang: item.lang,
      batchId: item.batchId,
      translationId: map.get(unitId)?.translationId ?? null,
      exampleSetId: item.id,
    })
  }

  return map
}

function mapBatchRow(row: UpdateBatchRow): UpdateBatchRecord {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    inputManifest: JSON.parse(row.input_manifest_json) as Record<string, unknown>,
    notes: row.notes,
    status: row.status,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    actor: row.actor,
  }
}

function mapTranslationRow(row: TranslationUpdateRow): DetailedTranslationUpdate {
  return {
    id: row.id,
    wordId: row.word_id,
    lang: row.lang,
    definitions: JSON.parse(row.definitions_json) as string[],
    sources: JSON.parse(row.sources_json) as string[],
    sourceType: row.source_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    batchId: row.batch_id,
    supersedesUpdateId: row.supersedes_update_id,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewNotes: row.review_notes,
  }
}

function mapExampleRows(
  setRow: ExampleUpdateSetRow,
  items: ExampleUpdateRow[]
): DetailedExampleUpdateSet {
  return {
    id: setRow.id,
    wordId: setRow.word_id,
    lang: setRow.lang,
    sourceType: setRow.source_type,
    status: setRow.status,
    createdAt: setRow.created_at,
    updatedAt: setRow.updated_at,
    batchId: setRow.batch_id,
    supersedesSetId: setRow.supersedes_set_id,
    reviewStatus: setRow.review_status,
    reviewedAt: setRow.reviewed_at,
    reviewedBy: setRow.reviewed_by,
    reviewNotes: setRow.review_notes,
    examples: items.map((item) => ({
      wordId: item.word_id,
      lang: item.lang,
      japanese: item.japanese,
      translation: item.translation,
      source: item.source,
    })),
  }
}

function getBatchMap(db: Database): Map<number, UpdateBatchRecord> {
  const rows = db.query<UpdateBatchRow, []>(`
    SELECT *
    FROM update_batches
  `).all()

  return new Map(rows.map((row) => [row.id, mapBatchRow(row)]))
}

function getExampleRowsForSet(db: Database, setId: number): ExampleUpdateRow[] {
  return db.query<ExampleUpdateRow, [number]>(`
    SELECT *
    FROM example_updates
    WHERE set_id = ?1
    ORDER BY id
  `).all(setId)
}

function getActiveTranslationUpdateRow(
  db: Database,
  wordId: string,
  lang: string,
  mode: 'effective' | 'active-any' = 'effective'
): TranslationUpdateRow | null {
  const reviewClause = mode === 'effective'
    ? `AND (source_type = 'source' OR review_status = 'approved')`
    : ''

  return db.query<TranslationUpdateRow, [string, string]>(`
    SELECT *
    FROM translation_updates
    WHERE word_id = ?1 AND lang = ?2 AND status = 'active'
    ${reviewClause}
    ORDER BY CASE source_type WHEN 'source' THEN 2 ELSE 1 END DESC, id DESC
    LIMIT 1
  `).get(wordId, lang) ?? null
}

function getActiveExampleUpdateSetRow(
  db: Database,
  wordId: string,
  lang: string,
  mode: 'effective' | 'active-any' = 'effective'
): ExampleUpdateSetRow | null {
  const reviewClause = mode === 'effective'
    ? `AND (source_type = 'source' OR review_status = 'approved')`
    : ''

  return db.query<ExampleUpdateSetRow, [string, string]>(`
    SELECT *
    FROM example_update_sets
    WHERE word_id = ?1 AND lang = ?2 AND status = 'active'
    ${reviewClause}
    ORDER BY CASE source_type WHEN 'source' THEN 2 ELSE 1 END DESC, id DESC
    LIMIT 1
  `).get(wordId, lang) ?? null
}

function updateReviewMetadata(
  db: Database,
  tableName: 'translation_updates' | 'example_update_sets',
  id: number,
  reviewStatus: Extract<ReviewStatus, 'approved' | 'rejected'>,
  actor: string,
  notes?: string | null
): void {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE ${tableName}
    SET review_status = ?2,
        reviewed_at = ?3,
        reviewed_by = ?4,
        review_notes = ?5,
        updated_at = ?3
    WHERE id = ?1
  `).run(id, reviewStatus, now, actor, notes ?? null)
}

export function openUpdatesDb(path?: string): Database {
  return initUpdatesDatabase(path)
}

export { initUpdatesDatabase }

export function insertUpdateBatch(db: Database, input: UpdateBatchInput): number {
  const now = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO update_batches (
      kind, created_at, input_manifest_json, notes, status, completed_at, error_message, actor
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.kind,
    now,
    JSON.stringify(input.inputManifest),
    input.notes ?? null,
    'running',
    null,
    null,
    input.actor ?? null,
  )

  return Number(result.lastInsertRowid)
}

export function finalizeUpdateBatch(
  db: Database,
  batchId: number,
  status: UpdateBatchStatus,
  errorMessage?: string | null
): void {
  db.prepare(`
    UPDATE update_batches
    SET status = ?2,
        completed_at = ?3,
        error_message = ?4
    WHERE id = ?1
  `).run(batchId, status, new Date().toISOString(), errorMessage ?? null)
}

export function getUpdateBatch(db: Database, batchId: number): UpdateBatchRecord | null {
  const row = db.query<UpdateBatchRow, [number]>(`
    SELECT *
    FROM update_batches
    WHERE id = ?1
  `).get(batchId)
  return row ? mapBatchRow(row) : null
}

export function listUpdateBatches(db: Database, limit = 20): UpdateBatchRecord[] {
  return db.query<UpdateBatchRow, [number]>(`
    SELECT *
    FROM update_batches
    ORDER BY id DESC
    LIMIT ?1
  `).all(limit).map(mapBatchRow)
}

export function recordAdminAction(db: Database, input: AdminActionInput): number {
  const result = db.prepare(`
    INSERT INTO admin_actions (actor, action, target_kind, target_id, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.actor,
    input.action,
    input.targetKind,
    input.targetId,
    input.notes ?? null,
    new Date().toISOString(),
  )

  return Number(result.lastInsertRowid)
}

export function getActiveTranslationUpdate(
  db: Database,
  wordId: string,
  lang: string
): ReleaseTranslationRecord | null {
  const row = getActiveTranslationUpdateRow(db, wordId, lang, 'effective')
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
  const setRow = getActiveExampleUpdateSetRow(db, wordId, lang, 'effective')
  if (!setRow) return null

  const items = getExampleRowsForSet(db, setRow.id)
  return {
    setId: setRow.id,
    sourceType: setRow.source_type,
    reviewStatus: setRow.review_status,
    examples: items.map((item) => ({
      wordId: item.word_id,
      lang: item.lang,
      japanese: item.japanese,
      translation: item.translation,
      source: item.source,
    })),
  }
}

export function getLatestTranslationUpdateBySourceType(
  db: Database,
  wordId: string,
  lang: string,
  sourceType: UpdateSourceType
): DetailedTranslationUpdate | null {
  const row = db.query<TranslationUpdateRow, [string, string, UpdateSourceType]>(`
    SELECT *
    FROM translation_updates
    WHERE word_id = ?1 AND lang = ?2 AND source_type = ?3
    ORDER BY CASE status WHEN 'active' THEN 3 WHEN 'superseded' THEN 2 ELSE 1 END DESC, id DESC
    LIMIT 1
  `).get(wordId, lang, sourceType)

  return row ? mapTranslationRow(row) : null
}

export function getActiveTranslationUpdateBySourceType(
  db: Database,
  wordId: string,
  lang: string,
  sourceType: UpdateSourceType
): DetailedTranslationUpdate | null {
  const row = db.query<TranslationUpdateRow, [string, string, UpdateSourceType]>(`
    SELECT *
    FROM translation_updates
    WHERE word_id = ?1
      AND lang = ?2
      AND source_type = ?3
      AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(wordId, lang, sourceType)

  return row ? mapTranslationRow(row) : null
}

export function getLatestExampleUpdateSetBySourceType(
  db: Database,
  wordId: string,
  lang: string,
  sourceType: UpdateSourceType
): DetailedExampleUpdateSet | null {
  const row = db.query<ExampleUpdateSetRow, [string, string, UpdateSourceType]>(`
    SELECT *
    FROM example_update_sets
    WHERE word_id = ?1 AND lang = ?2 AND source_type = ?3
    ORDER BY CASE status WHEN 'active' THEN 3 WHEN 'superseded' THEN 2 ELSE 1 END DESC, id DESC
    LIMIT 1
  `).get(wordId, lang, sourceType)

  return row ? mapExampleRows(row, getExampleRowsForSet(db, row.id)) : null
}

export function getActiveExampleUpdateSetBySourceType(
  db: Database,
  wordId: string,
  lang: string,
  sourceType: UpdateSourceType
): DetailedExampleUpdateSet | null {
  const row = db.query<ExampleUpdateSetRow, [string, string, UpdateSourceType]>(`
    SELECT *
    FROM example_update_sets
    WHERE word_id = ?1
      AND lang = ?2
      AND source_type = ?3
      AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(wordId, lang, sourceType)

  return row ? mapExampleRows(row, getExampleRowsForSet(db, row.id)) : null
}

export function insertTranslationUpdate(db: Database, input: TranslationUpdateInput): number {
  const now = new Date().toISOString()
  const reviewStatus = input.reviewStatus ?? defaultReviewStatus(input.sourceType)

  const run = db.transaction((payload: TranslationUpdateInput, normalizedReviewStatus: ReviewStatus) => {
    const active = getActiveTranslationUpdateRow(db, payload.wordId, payload.lang, 'active-any')
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
        created_at, updated_at, batch_id, supersedes_update_id,
        review_status, reviewed_at, reviewed_by, review_notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      normalizedReviewStatus,
      normalizedReviewStatus === 'approved' || normalizedReviewStatus === 'rejected' ? now : null,
      normalizedReviewStatus === 'approved' || normalizedReviewStatus === 'rejected' ? 'system-migration' : null,
      null,
    )

    return Number(result.lastInsertRowid)
  })

  return run(input, reviewStatus)
}

export function insertExampleUpdateSet(db: Database, input: ExampleSetUpdateInput): number {
  const now = new Date().toISOString()
  const reviewStatus = input.reviewStatus ?? defaultReviewStatus(input.sourceType)

  const run = db.transaction((payload: ExampleSetUpdateInput, normalizedReviewStatus: ReviewStatus) => {
    const activeSet = getActiveExampleUpdateSetRow(db, payload.wordId, payload.lang, 'active-any')
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
        word_id, lang, source_type, status, created_at, updated_at, batch_id, supersedes_set_id,
        review_status, reviewed_at, reviewed_by, review_notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.wordId,
      payload.lang,
      payload.sourceType,
      status,
      now,
      now,
      payload.batchId,
      supersedesSetId,
      normalizedReviewStatus,
      normalizedReviewStatus === 'approved' || normalizedReviewStatus === 'rejected' ? now : null,
      normalizedReviewStatus === 'approved' || normalizedReviewStatus === 'rejected' ? 'system-migration' : null,
      null,
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

  return run(input, reviewStatus)
}

export function approveTranslationUpdate(
  db: Database,
  id: number,
  actor: string,
  notes?: string | null
): DetailedTranslationUpdate | null {
  const row = db.query<TranslationUpdateRow, [number]>(`
    SELECT *
    FROM translation_updates
    WHERE id = ?1
  `).get(id)

  if (!row) return null
  if (row.source_type !== 'ai') return mapTranslationRow(row)

  updateReviewMetadata(db, 'translation_updates', id, 'approved', actor, notes)
  const updated = db.query<TranslationUpdateRow, [number]>(`
    SELECT *
    FROM translation_updates
    WHERE id = ?1
  `).get(id)

  return updated ? mapTranslationRow(updated) : null
}

export function rejectTranslationUpdate(
  db: Database,
  id: number,
  actor: string,
  notes?: string | null
): DetailedTranslationUpdate | null {
  const row = db.query<TranslationUpdateRow, [number]>(`
    SELECT *
    FROM translation_updates
    WHERE id = ?1
  `).get(id)

  if (!row) return null
  if (row.source_type !== 'ai') return mapTranslationRow(row)

  updateReviewMetadata(db, 'translation_updates', id, 'rejected', actor, notes)
  const updated = db.query<TranslationUpdateRow, [number]>(`
    SELECT *
    FROM translation_updates
    WHERE id = ?1
  `).get(id)

  return updated ? mapTranslationRow(updated) : null
}

export function approveExampleUpdateSet(
  db: Database,
  id: number,
  actor: string,
  notes?: string | null
): DetailedExampleUpdateSet | null {
  const row = db.query<ExampleUpdateSetRow, [number]>(`
    SELECT *
    FROM example_update_sets
    WHERE id = ?1
  `).get(id)

  if (!row) return null
  if (row.source_type !== 'ai') return mapExampleRows(row, getExampleRowsForSet(db, row.id))

  updateReviewMetadata(db, 'example_update_sets', id, 'approved', actor, notes)
  const updated = db.query<ExampleUpdateSetRow, [number]>(`
    SELECT *
    FROM example_update_sets
    WHERE id = ?1
  `).get(id)

  return updated ? mapExampleRows(updated, getExampleRowsForSet(db, updated.id)) : null
}

export function rejectExampleUpdateSet(
  db: Database,
  id: number,
  actor: string,
  notes?: string | null
): DetailedExampleUpdateSet | null {
  const row = db.query<ExampleUpdateSetRow, [number]>(`
    SELECT *
    FROM example_update_sets
    WHERE id = ?1
  `).get(id)

  if (!row) return null
  if (row.source_type !== 'ai') return mapExampleRows(row, getExampleRowsForSet(db, row.id))

  updateReviewMetadata(db, 'example_update_sets', id, 'rejected', actor, notes)
  const updated = db.query<ExampleUpdateSetRow, [number]>(`
    SELECT *
    FROM example_update_sets
    WHERE id = ?1
  `).get(id)

  return updated ? mapExampleRows(updated, getExampleRowsForSet(db, updated.id)) : null
}

export function markAllActiveUpdatesPromoted(db: Database): void {
  const now = new Date().toISOString()
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE translation_updates
      SET status = 'promoted', updated_at = ?1
      WHERE status = 'active'
        AND (source_type = 'source' OR review_status = 'approved')
    `).run(now)

    db.prepare(`
      UPDATE example_update_sets
      SET status = 'promoted', updated_at = ?1
      WHERE status = 'active'
        AND (source_type = 'source' OR review_status = 'approved')
    `).run(now)

    db.prepare(`
      UPDATE example_updates
      SET status = 'promoted'
      WHERE set_id IN (
        SELECT id
        FROM example_update_sets
        WHERE status = 'promoted'
      )
    `).run()
  })

  transaction()
}

export function verifyUpdatesAgainstWordIds(
  db: Database,
  validWordIds: Set<string>
): UpdateVerificationSummary {
  const translationRows = db.query<{
    word_id: string
    status: string
    source_type: UpdateSourceType
    review_status: ReviewStatus
  }, []>(`
    SELECT word_id, status, source_type, review_status
    FROM translation_updates
  `).all()
  const exampleSetRows = db.query<{
    word_id: string
    status: string
    source_type: UpdateSourceType
    review_status: ReviewStatus
  }, []>(`
    SELECT word_id, status, source_type, review_status
    FROM example_update_sets
  `).all()

  const translationCounts: Record<string, number> = {}
  const exampleSetCounts: Record<string, number> = {}
  const reviewCounts: Record<string, number> = {}

  for (const row of translationRows) {
    translationCounts[row.status] = (translationCounts[row.status] || 0) + 1
    const reviewKey = `translation:${row.review_status}`
    reviewCounts[reviewKey] = (reviewCounts[reviewKey] || 0) + 1
  }

  for (const row of exampleSetRows) {
    exampleSetCounts[row.status] = (exampleSetCounts[row.status] || 0) + 1
    const reviewKey = `example:${row.review_status}`
    reviewCounts[reviewKey] = (reviewCounts[reviewKey] || 0) + 1
  }

  const orphaned = new Set<string>()
  for (const row of translationRows) {
    if (!validWordIds.has(row.word_id)) orphaned.add(row.word_id)
  }
  for (const row of exampleSetRows) {
    if (!validWordIds.has(row.word_id)) orphaned.add(row.word_id)
  }

  const activeReviewedAiCount = translationRows.filter((row) =>
    row.status === 'active' && row.source_type === 'ai' && row.review_status === 'approved'
  ).length + exampleSetRows.filter((row) =>
    row.status === 'active' && row.source_type === 'ai' && row.review_status === 'approved'
  ).length

  return {
    translationCounts,
    exampleSetCounts,
    reviewCounts,
    orphanedWordIds: [...orphaned].sort(),
    activeReviewedAiCount,
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
        WHERE status = 'active'
          AND source_type = ?1
          AND (?1 = 'source' OR review_status = 'approved')
      `).all(sourceType)
    : db.query<TranslationUpdateRow, []>(`
        SELECT *
        FROM translation_updates
        WHERE status = 'active'
          AND (source_type = 'source' OR review_status = 'approved')
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
        WHERE status = 'active'
          AND source_type = ?1
          AND (?1 = 'source' OR review_status = 'approved')
      `).all(sourceType)
    : db.query<ExampleUpdateSetRow, []>(`
        SELECT *
        FROM example_update_sets
        WHERE status = 'active'
          AND (source_type = 'source' OR review_status = 'approved')
      `).all()

  for (const setRow of sets) {
    const items = getExampleRowsForSet(db, setRow.id)
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

export function listTranslationUpdates(
  db: Database,
  filters: UpdateListFilters = {}
): ListedTranslationUpdate[] {
  const clauses = ['1 = 1']
  const params: Array<string | number> = []

  if (filters.lang) {
    params.push(filters.lang)
    clauses.push(`lang = ?${params.length}`)
  }
  if (filters.sourceType) {
    params.push(filters.sourceType)
    clauses.push(`source_type = ?${params.length}`)
  }
  if (filters.status) {
    params.push(filters.status)
    clauses.push(`status = ?${params.length}`)
  }
  if (filters.reviewStatus) {
    params.push(filters.reviewStatus)
    clauses.push(`review_status = ?${params.length}`)
  }
  if (filters.batchId !== undefined && filters.batchId !== null) {
    params.push(filters.batchId)
    clauses.push(`batch_id = ?${params.length}`)
  }

  params.push(filters.limit ?? 100)
  const rows = db.query<TranslationUpdateRow, Array<string | number>>(`
    SELECT *
    FROM translation_updates
    WHERE ${clauses.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?${params.length}
  `).all(...params)

  const batchMap = getBatchMap(db)
  return rows.map((row) => ({
    ...mapTranslationRow(row),
    batch: batchMap.get(row.batch_id) ?? null,
  }))
}

export function listExampleUpdateSets(
  db: Database,
  filters: UpdateListFilters = {}
): ListedExampleUpdateSet[] {
  const clauses = ['1 = 1']
  const params: Array<string | number> = []

  if (filters.lang) {
    params.push(filters.lang)
    clauses.push(`lang = ?${params.length}`)
  }
  if (filters.sourceType) {
    params.push(filters.sourceType)
    clauses.push(`source_type = ?${params.length}`)
  }
  if (filters.status) {
    params.push(filters.status)
    clauses.push(`status = ?${params.length}`)
  }
  if (filters.reviewStatus) {
    params.push(filters.reviewStatus)
    clauses.push(`review_status = ?${params.length}`)
  }
  if (filters.batchId !== undefined && filters.batchId !== null) {
    params.push(filters.batchId)
    clauses.push(`batch_id = ?${params.length}`)
  }

  params.push(filters.limit ?? 100)
  const rows = db.query<ExampleUpdateSetRow, Array<string | number>>(`
    SELECT *
    FROM example_update_sets
    WHERE ${clauses.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?${params.length}
  `).all(...params)

  const batchMap = getBatchMap(db)
  return rows.map((row) => ({
    ...mapExampleRows(row, getExampleRowsForSet(db, row.id)),
    batch: batchMap.get(row.batch_id) ?? null,
  }))
}

export function listPendingAiTranslationUpdates(
  db: Database,
  filters: PendingReviewUnitKeyFilters = {}
): ListedTranslationUpdate[] {
  const clauses = [
    `source_type = 'ai'`,
    `status = 'active'`,
    `review_status = 'pending'`,
  ]
  const params: Array<string | number> = []

  if (filters.lang) {
    params.push(filters.lang)
    clauses.push(`lang = ?${params.length}`)
  }
  if (filters.batchId !== undefined && filters.batchId !== null) {
    params.push(filters.batchId)
    clauses.push(`batch_id = ?${params.length}`)
  }

  const rows = db.query<TranslationUpdateRow, Array<string | number>>(`
    SELECT *
    FROM translation_updates
    WHERE ${clauses.join(' AND ')}
    ORDER BY batch_id DESC, word_id ASC, lang ASC, id DESC
  `).all(...params)

  const batchMap = getBatchMap(db)
  return rows.map((row) => ({
    ...mapTranslationRow(row),
    batch: batchMap.get(row.batch_id) ?? null,
  }))
}

export function listPendingAiExampleUpdateSets(
  db: Database,
  filters: PendingReviewUnitKeyFilters = {}
): ListedExampleUpdateSet[] {
  const clauses = [
    `source_type = 'ai'`,
    `status = 'active'`,
    `review_status = 'pending'`,
  ]
  const params: Array<string | number> = []

  if (filters.lang) {
    params.push(filters.lang)
    clauses.push(`lang = ?${params.length}`)
  }
  if (filters.batchId !== undefined && filters.batchId !== null) {
    params.push(filters.batchId)
    clauses.push(`batch_id = ?${params.length}`)
  }

  const rows = db.query<ExampleUpdateSetRow, Array<string | number>>(`
    SELECT *
    FROM example_update_sets
    WHERE ${clauses.join(' AND ')}
    ORDER BY batch_id DESC, word_id ASC, lang ASC, id DESC
  `).all(...params)

  const batchMap = getBatchMap(db)
  return rows.map((row) => ({
    ...mapExampleRows(row, getExampleRowsForSet(db, row.id)),
    batch: batchMap.get(row.batch_id) ?? null,
  }))
}

export function listPendingReviewUnitKeys(
  db: Database,
  filters: PendingReviewUnitKeyFilters & {
    cursor?: string | null
    limit?: number | null
  } = {}
): PendingReviewUnitKeyPageResult {
  const translations = listPendingAiTranslationUpdates(db, filters)
  const exampleSets = listPendingAiExampleUpdateSets(db, filters)
  const map = buildPendingReviewUnitKeyMap(translations, exampleSets)
  const items = [...map.values()].sort(comparePendingReviewUnitOrder)
  const cursor = filters.cursor ? parsePendingReviewCursor(filters.cursor) : null
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200))

  const startIndex = cursor
    ? items.findIndex((item) => comparePendingReviewUnitOrder(item, cursor) > 0)
    : 0

  const normalizedStartIndex = startIndex >= 0 ? startIndex : 0
  const pageItems = items.slice(normalizedStartIndex, normalizedStartIndex + limit)
  const last = pageItems[pageItems.length - 1]

  return {
    items: pageItems,
    nextCursor: last && normalizedStartIndex + pageItems.length < items.length
      ? last.unitId
      : null,
  }
}

export function applyBulkReviewStatus(
  db: Database,
  input: BulkReviewStatusInput
): BulkReviewStatusResult {
  const update = db.transaction((payload: BulkReviewStatusInput): BulkReviewStatusResult => {
    const approvedTranslationIds: number[] = []
    const approvedExampleSetIds: number[] = []

    for (const id of payload.translationIds) {
      const row = db.query<TranslationUpdateRow, [number]>(`
        SELECT *
        FROM translation_updates
        WHERE id = ?1
      `).get(id)

      if (!row || row.source_type !== 'ai') continue
      updateReviewMetadata(db, 'translation_updates', id, payload.reviewStatus, payload.actor, payload.notes)
      approvedTranslationIds.push(id)
    }

    for (const id of payload.exampleSetIds) {
      const row = db.query<ExampleUpdateSetRow, [number]>(`
        SELECT *
        FROM example_update_sets
        WHERE id = ?1
      `).get(id)

      if (!row || row.source_type !== 'ai') continue
      updateReviewMetadata(db, 'example_update_sets', id, payload.reviewStatus, payload.actor, payload.notes)
      approvedExampleSetIds.push(id)
    }

    return {
      translationIds: approvedTranslationIds,
      exampleSetIds: approvedExampleSetIds,
    }
  })

  return update(input)
}
