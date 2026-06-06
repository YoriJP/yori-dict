import { getOrCreateYoriId, type IdRegistry } from './ids'
import type {
  CanonicalSnapshot,
  Entry,
  Example,
  Gloss,
  LookupAlias,
  ReviewStatus,
  SourceRef,
  TargetLanguage,
} from './types'

type OverlaySourceKind = 'manual' | 'ai'

export interface AiOverlayMetadata {
  model: string
  promptVersion: string
  inputRefs: string[]
}

interface OverlayBase {
  id: string
  sourceKind: OverlaySourceKind
  sourceId?: string
  importedAt: string
  reviewStatus: ReviewStatus
  model?: string
  promptVersion?: string
  inputRefs?: string[]
}

export interface AddGlossOverlay extends OverlayBase {
  type: 'addGloss'
  senseId: string
  lang: TargetLanguage
  text: string
}

export interface ReplaceGlossesOverlay extends OverlayBase {
  type: 'replaceGlosses'
  senseId: string
  lang: TargetLanguage
  glosses: string[]
}

export interface AddExampleOverlay extends OverlayBase {
  type: 'addExample'
  senseId: string
  lang: TargetLanguage
  japanese: string
  translation: string
}

export interface UpsertEntryOverlay extends OverlayBase {
  type: 'upsertEntry'
  entry: Entry
  lookupAliases?: LookupAlias[]
}

export type CanonicalOverlayOperation =
  | AddGlossOverlay
  | ReplaceGlossesOverlay
  | AddExampleOverlay
  | UpsertEntryOverlay

export interface CanonicalOverlayFile {
  schemaVersion: '1.0.0'
  operations: CanonicalOverlayOperation[]
}

export interface OverlayIssue {
  path: string
  message: string
}

export interface OverlayValidationResult {
  valid: boolean
  errors: OverlayIssue[]
}

export interface OverlayApplyStats {
  operationsProcessed: number
  operationsApplied: number
  operationsSkipped: number
  glossesAdded: number
  examplesAdded: number
  entriesUpserted: number
}

export interface OverlayApplyOptions {
  registry: IdRegistry
}

export interface OverlayOperationIdInput {
  sourceKind: OverlaySourceKind
  targetId: string
  action: CanonicalOverlayOperation['type']
  lang?: TargetLanguage
  promptVersion?: string
  date: string | Date
}

export interface ManualOverlayBaseInput {
  id?: string
  importedAt: string
  reviewStatus?: ReviewStatus
}

export interface CreateGlossOverlayInput extends ManualOverlayBaseInput {
  senseId: string
  lang: TargetLanguage
  text: string
}

export interface CreateReplaceGlossesOverlayInput extends ManualOverlayBaseInput {
  senseId: string
  lang: TargetLanguage
  glosses: string[]
}

export interface CreateExampleOverlayInput extends ManualOverlayBaseInput {
  senseId: string
  lang: TargetLanguage
  japanese: string
  translation: string
}

export interface CreateAiGlossOverlayInput extends CreateGlossOverlayInput, AiOverlayMetadata {}

function issue(path: string, message: string): OverlayIssue {
  return { path, message }
}

function formatIssueDetails(issues: OverlayIssue[]): string {
  return issues.slice(0, 5).map((item) => `${item.path}: ${item.message}`).join('; ')
}

function cloneSnapshot(snapshot: CanonicalSnapshot): CanonicalSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as CanonicalSnapshot
}

function sourceRef(op: OverlayBase): SourceRef {
  return {
    kind: op.sourceKind,
    sourceId: op.sourceId ?? op.id,
    importedAt: op.importedAt,
    model: op.model,
    promptVersion: op.promptVersion,
    inputRefs: op.inputRefs,
    reviewStatus: op.reviewStatus,
  }
}

function sourceKey(op: OverlayBase, entity: 'gloss' | 'example', suffix = ''): string {
  return `overlay:${op.id}:${entity}${suffix ? `:${suffix}` : ''}`
}

function isApproved(op: OverlayBase): boolean {
  return op.reviewStatus === 'approved'
}

function compactIdPart(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function formatOperationDate(date: string | Date): string {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new Error('date must be valid')
    return date.toISOString().slice(0, 10).replace(/-/g, '')
  }

  const normalized = date.trim()
  if (/^\d{8}$/.test(normalized)) return normalized

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new Error('date must be YYYYMMDD, an ISO date string, or a Date')
  return parsed.toISOString().slice(0, 10).replace(/-/g, '')
}

function assertManualInput(input: ManualOverlayBaseInput): void {
  if (!input.importedAt?.trim()) throw new Error('importedAt is required')
  if (input.reviewStatus && !['unreviewed', 'approved', 'rejected'].includes(input.reviewStatus)) {
    throw new Error('reviewStatus is invalid')
  }
}

function assertAiMetadata(input: AiOverlayMetadata): void {
  if (!input.model?.trim()) throw new Error('AI overlays must include model')
  if (!input.promptVersion?.trim()) throw new Error('AI overlays must include promptVersion')
  if (!Array.isArray(input.inputRefs) || input.inputRefs.length === 0) {
    throw new Error('AI overlays must include inputRefs')
  }
}

function defaultOperationId(
  sourceKind: OverlaySourceKind,
  targetId: string,
  action: CanonicalOverlayOperation['type'],
  lang: TargetLanguage | undefined,
  importedAt: string,
  promptVersion?: string
): string {
  return formatOverlayOperationId({
    sourceKind,
    targetId,
    action,
    lang,
    promptVersion,
    date: importedAt,
  })
}

export function formatOverlayOperationId(input: OverlayOperationIdInput): string {
  if (!input.targetId?.trim()) throw new Error('targetId is required')
  if (input.sourceKind === 'ai' && !input.promptVersion?.trim()) {
    throw new Error('AI overlay operation IDs require promptVersion')
  }

  const parts = [
    input.sourceKind,
    compactIdPart(input.targetId),
    compactIdPart(input.action),
    input.lang,
    input.sourceKind === 'ai' ? compactIdPart(input.promptVersion ?? '') : undefined,
    formatOperationDate(input.date),
  ].filter((part): part is string => Boolean(part))

  return parts.join('-')
}

export function createManualAddGlossOverlay(input: CreateGlossOverlayInput): AddGlossOverlay {
  assertManualInput(input)
  return {
    id: input.id ?? defaultOperationId('manual', input.senseId, 'addGloss', input.lang, input.importedAt),
    type: 'addGloss',
    sourceKind: 'manual',
    importedAt: input.importedAt,
    reviewStatus: input.reviewStatus ?? 'unreviewed',
    senseId: input.senseId,
    lang: input.lang,
    text: input.text,
  }
}

export function createManualReplaceGlossesOverlay(input: CreateReplaceGlossesOverlayInput): ReplaceGlossesOverlay {
  assertManualInput(input)
  return {
    id: input.id ?? defaultOperationId('manual', input.senseId, 'replaceGlosses', input.lang, input.importedAt),
    type: 'replaceGlosses',
    sourceKind: 'manual',
    importedAt: input.importedAt,
    reviewStatus: input.reviewStatus ?? 'unreviewed',
    senseId: input.senseId,
    lang: input.lang,
    glosses: input.glosses,
  }
}

export function createManualAddExampleOverlay(input: CreateExampleOverlayInput): AddExampleOverlay {
  assertManualInput(input)
  return {
    id: input.id ?? defaultOperationId('manual', input.senseId, 'addExample', input.lang, input.importedAt),
    type: 'addExample',
    sourceKind: 'manual',
    importedAt: input.importedAt,
    reviewStatus: input.reviewStatus ?? 'unreviewed',
    senseId: input.senseId,
    lang: input.lang,
    japanese: input.japanese,
    translation: input.translation,
  }
}

export function createAiAddGlossOverlay(input: CreateAiGlossOverlayInput): AddGlossOverlay {
  assertManualInput(input)
  assertAiMetadata(input)
  return {
    id: input.id ?? defaultOperationId('ai', input.senseId, 'addGloss', input.lang, input.importedAt, input.promptVersion),
    type: 'addGloss',
    sourceKind: 'ai',
    importedAt: input.importedAt,
    reviewStatus: input.reviewStatus ?? 'unreviewed',
    model: input.model,
    promptVersion: input.promptVersion,
    inputRefs: input.inputRefs,
    senseId: input.senseId,
    lang: input.lang,
    text: input.text,
  }
}

export function approveOverlayOperation(operation: CanonicalOverlayOperation): CanonicalOverlayOperation {
  return {
    ...operation,
    reviewStatus: 'approved',
  }
}

export function rejectOverlayOperation(operation: CanonicalOverlayOperation): CanonicalOverlayOperation {
  if (operation.reviewStatus === 'approved') {
    throw new Error('Approved overlay operations cannot be rejected in place')
  }
  return {
    ...operation,
    reviewStatus: 'rejected',
  }
}

function validateOperationBase(op: CanonicalOverlayOperation, path: string, errors: OverlayIssue[]): void {
  if (!op.id?.trim()) errors.push(issue(`${path}.id`, 'overlay operation id is required'))
  if (!['manual', 'ai'].includes(op.sourceKind)) {
    errors.push(issue(`${path}.sourceKind`, 'sourceKind must be manual or ai'))
  }
  if (!op.importedAt) errors.push(issue(`${path}.importedAt`, 'importedAt is required'))
  if (!['unreviewed', 'approved', 'rejected'].includes(op.reviewStatus)) {
    errors.push(issue(`${path}.reviewStatus`, 'invalid reviewStatus'))
  }
  if (op.sourceKind === 'ai') {
    if (!op.model?.trim()) errors.push(issue(`${path}.model`, 'AI overlays must include model'))
    if (!op.promptVersion?.trim()) errors.push(issue(`${path}.promptVersion`, 'AI overlays must include promptVersion'))
    if (!Array.isArray(op.inputRefs) || op.inputRefs.length === 0) {
      errors.push(issue(`${path}.inputRefs`, 'AI overlays must include inputRefs'))
    }
  }
}

export function validateCanonicalOverlayFile(file: unknown): OverlayValidationResult {
  const errors: OverlayIssue[] = []
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return { valid: false, errors: [issue('overlay', 'overlay file must be an object')] }
  }

  const overlay = file as CanonicalOverlayFile
  if (overlay.schemaVersion !== '1.0.0') errors.push(issue('schemaVersion', 'schemaVersion must be 1.0.0'))
  if (!Array.isArray(overlay.operations)) {
    errors.push(issue('operations', 'operations must be an array'))
    return { valid: false, errors }
  }

  const ids = new Set<string>()
  overlay.operations.forEach((rawOp, index) => {
    const path = `operations[${index}]`
    if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
      errors.push(issue(path, 'operation must be an object'))
      return
    }

    const op = rawOp as CanonicalOverlayOperation
    validateOperationBase(op, path, errors)
    if (ids.has(op.id)) errors.push(issue(`${path}.id`, `duplicate overlay operation id: ${op.id}`))
    ids.add(op.id)

    if (op.type === 'addGloss') {
      if (!op.senseId?.trim()) errors.push(issue(`${path}.senseId`, 'senseId is required'))
      if (!op.text?.trim()) errors.push(issue(`${path}.text`, 'text is required'))
    } else if (op.type === 'replaceGlosses') {
      if (!op.senseId?.trim()) errors.push(issue(`${path}.senseId`, 'senseId is required'))
      if (!Array.isArray(op.glosses) || op.glosses.length === 0) {
        errors.push(issue(`${path}.glosses`, 'glosses must contain at least one gloss'))
      }
    } else if (op.type === 'addExample') {
      if (!op.senseId?.trim()) errors.push(issue(`${path}.senseId`, 'senseId is required'))
      if (!op.japanese?.trim()) errors.push(issue(`${path}.japanese`, 'japanese is required'))
      if (!op.translation?.trim()) errors.push(issue(`${path}.translation`, 'translation is required'))
    } else if (op.type === 'upsertEntry') {
      if (!op.entry?.id) errors.push(issue(`${path}.entry`, 'entry is required'))
    } else {
      errors.push(issue(`${path}.type`, 'unknown overlay operation type'))
    }
  })

  return { valid: errors.length === 0, errors }
}

function findSense(snapshot: CanonicalSnapshot, senseId: string): { entry: Entry; senseIndex: number } | null {
  for (const entry of snapshot.entries) {
    const senseIndex = entry.senses.findIndex((sense) => sense.id === senseId)
    if (senseIndex >= 0) return { entry, senseIndex }
  }
  return null
}

function addGloss(snapshot: CanonicalSnapshot, op: AddGlossOverlay, opts: OverlayApplyOptions): number {
  const match = findSense(snapshot, op.senseId)
  if (!match) return 0
  const sense = match.entry.senses[match.senseIndex]
  const text = op.text.trim()
  if (sense.glosses.some((gloss) => gloss.lang === op.lang && gloss.text === text)) return 0

  sense.glosses.push({
    id: getOrCreateYoriId(opts.registry, 'gloss', sourceKey(op, 'gloss')),
    senseId: sense.id,
    lang: op.lang,
    text,
    sourceType: op.sourceKind,
    reviewStatus: op.reviewStatus,
    sourceRefs: [sourceRef(op)],
  })
  return 1
}

function replaceGlosses(snapshot: CanonicalSnapshot, op: ReplaceGlossesOverlay, opts: OverlayApplyOptions): number {
  const match = findSense(snapshot, op.senseId)
  if (!match) return 0
  const sense = match.entry.senses[match.senseIndex]
  sense.glosses = sense.glosses.filter((gloss) => gloss.lang !== op.lang)

  let added = 0
  for (const [index, text] of [...new Set(op.glosses.map((gloss) => gloss.trim()).filter(Boolean))].entries()) {
    sense.glosses.push({
      id: getOrCreateYoriId(opts.registry, 'gloss', sourceKey(op, 'gloss', String(index + 1))),
      senseId: sense.id,
      lang: op.lang,
      text,
      sourceType: op.sourceKind,
      reviewStatus: op.reviewStatus,
      sourceRefs: [sourceRef(op)],
    })
    added++
  }
  return added
}

function addExample(snapshot: CanonicalSnapshot, op: AddExampleOverlay, opts: OverlayApplyOptions): number {
  const match = findSense(snapshot, op.senseId)
  if (!match) return 0
  const sense = match.entry.senses[match.senseIndex]
  const japanese = op.japanese.trim()
  const translation = op.translation.trim()
  if (sense.examples.some((example) =>
    example.lang === op.lang && example.japanese === japanese && example.translation === translation
  )) return 0

  sense.examples.push({
    id: getOrCreateYoriId(opts.registry, 'example', sourceKey(op, 'example')),
    senseId: sense.id,
    lang: op.lang,
    japanese,
    translation,
    sourceRefs: [sourceRef(op)],
  })
  return 1
}

function upsertEntry(snapshot: CanonicalSnapshot, op: UpsertEntryOverlay): number {
  const entryIndex = snapshot.entries.findIndex((entry) => entry.id === op.entry.id)
  if (entryIndex >= 0) snapshot.entries[entryIndex] = op.entry
  else snapshot.entries.push(op.entry)

  if (op.lookupAliases) {
    snapshot.lookupAliases = snapshot.lookupAliases.filter((alias) => alias.entryId !== op.entry.id)
    snapshot.lookupAliases.push(...op.lookupAliases)
  }
  return 1
}

export function applyCanonicalOverlayFile(
  snapshot: CanonicalSnapshot,
  file: CanonicalOverlayFile,
  opts: OverlayApplyOptions
): { snapshot: CanonicalSnapshot; stats: OverlayApplyStats } {
  const result = validateCanonicalOverlayFile(file)
  if (!result.valid) {
    throw new Error(
      `Canonical overlay validation failed with ${result.errors.length} error(s): ${formatIssueDetails(result.errors)}`
    )
  }

  const next = cloneSnapshot(snapshot)
  const stats: OverlayApplyStats = {
    operationsProcessed: file.operations.length,
    operationsApplied: 0,
    operationsSkipped: 0,
    glossesAdded: 0,
    examplesAdded: 0,
    entriesUpserted: 0,
  }

  for (const op of file.operations) {
    if (!isApproved(op)) {
      stats.operationsSkipped++
      continue
    }

    if (op.type === 'addGloss') {
      const added = addGloss(next, op, opts)
      stats.glossesAdded += added
      added > 0 ? stats.operationsApplied++ : stats.operationsSkipped++
    } else if (op.type === 'replaceGlosses') {
      const added = replaceGlosses(next, op, opts)
      stats.glossesAdded += added
      added > 0 ? stats.operationsApplied++ : stats.operationsSkipped++
    } else if (op.type === 'addExample') {
      const added = addExample(next, op, opts)
      stats.examplesAdded += added
      added > 0 ? stats.operationsApplied++ : stats.operationsSkipped++
    } else if (op.type === 'upsertEntry') {
      stats.entriesUpserted += upsertEntry(next, op)
      stats.operationsApplied++
    }
  }

  return { snapshot: next, stats }
}
