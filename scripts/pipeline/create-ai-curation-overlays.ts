import {
  loadCanonicalOverlayFile,
  saveCanonicalOverlayFile,
} from '../../src/domain/overlay-store'
import { createAiAddGlossOverlay, type CanonicalOverlayOperation } from '../../src/domain/overlays'
import type { CurationQueue, CurationQueueItem } from '../../src/domain/curation-queue'

interface CliOptions {
  queue: string
  suggestions: string
  overlay: string
  model: string
  promptVersion: string
  importedAt: string
  limit?: number
}

interface AiGlossSuggestion {
  queueItemId: string
  text: string
}

const DEFAULT_OVERLAY = 'data/overlays/canonical-overlays.json'

function printHelp(): void {
  console.log(`
AI curation overlay suggestions

Converts AI-generated suggestion records into unreviewed canonical overlay
operations. This does not call an AI model.

Usage:
  bun run suggest:ai-overlays --queue <queue.json> --suggestions <suggestions.json> --model <model> --prompt-version <version>

Options:
  --queue <path>           Curation queue JSON.
  --suggestions <path>     AI suggestion JSON or JSONL.
  --overlay <path>         Overlay file (default: ${DEFAULT_OVERLAY})
  --model <name>           AI model that generated the suggestions.
  --prompt-version <name>  Prompt/version identifier.
  --imported-at <iso>      Creation timestamp (default: now).
  --limit <n>              Max overlay operations to create.
  --help, -h               Show this help.

Suggestion JSON shape:
  [{ "queueItemId": "missingGloss-yds_00000001-zh-tw", "text": "吃" }]
`)
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function requireString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    queue: '',
    suggestions: '',
    overlay: DEFAULT_OVERLAY,
    model: '',
    promptVersion: '',
    importedAt: new Date().toISOString(),
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--queue' && next) {
      opts.queue = next
      i++
    } else if (arg === '--suggestions' && next) {
      opts.suggestions = next
      i++
    } else if (arg === '--overlay' && next) {
      opts.overlay = next
      i++
    } else if (arg === '--model' && next) {
      opts.model = next
      i++
    } else if (arg === '--prompt-version' && next) {
      opts.promptVersion = next
      i++
    } else if (arg === '--imported-at' && next) {
      opts.importedAt = next
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = parsePositiveInt(next, '--limit')
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  requireString(opts.queue, '--queue')
  requireString(opts.suggestions, '--suggestions')
  requireString(opts.model, '--model')
  requireString(opts.promptVersion, '--prompt-version')
  return opts
}

function assertQueue(value: unknown): CurationQueue {
  const queue = value as CurationQueue
  if (!queue || queue.schemaVersion !== '1.0.0' || !Array.isArray(queue.items)) {
    throw new Error('Curation queue is invalid')
  }
  const ids = new Set<string>()
  for (const item of queue.items) {
    if (ids.has(item.id)) throw new Error(`Duplicate curation queue item id: ${item.id}`)
    ids.add(item.id)
  }
  return queue
}

function assertSuggestion(value: unknown, index: number): AiGlossSuggestion {
  const suggestion = value as AiGlossSuggestion
  if (!suggestion?.queueItemId?.trim()) throw new Error(`suggestions[${index}].queueItemId is required`)
  if (!suggestion.text?.trim()) throw new Error(`suggestions[${index}].text is required`)
  return {
    queueItemId: suggestion.queueItemId,
    text: suggestion.text,
  }
}

function parseSuggestionJson(value: unknown): AiGlossSuggestion[] {
  if (Array.isArray(value)) return value.map(assertSuggestion)
  if (value && typeof value === 'object') {
    const object = value as { suggestions?: unknown[] }
    if ('queueItemId' in object) return [assertSuggestion(object, 0)]
    if (Array.isArray(object.suggestions)) return object.suggestions.map(assertSuggestion)
  }
  throw new Error('Suggestion JSON must be an array, a suggestion object, or an object with suggestions')
}

function parseSuggestionText(text: string): AiGlossSuggestion[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  try {
    return parseSuggestionJson(JSON.parse(trimmed))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }

  return trimmed
    .split('\n')
    .filter(Boolean)
    .map((line, index) => assertSuggestion(JSON.parse(line), index))
}

async function loadQueue(path: string): Promise<CurationQueue> {
  return assertQueue(await Bun.file(path).json())
}

async function loadSuggestions(path: string): Promise<AiGlossSuggestion[]> {
  return parseSuggestionText(await Bun.file(path).text())
}

function mapSuggestions(suggestions: AiGlossSuggestion[]): Map<string, AiGlossSuggestion> {
  const result = new Map<string, AiGlossSuggestion>()
  for (const suggestion of suggestions) {
    if (result.has(suggestion.queueItemId)) {
      throw new Error(`Duplicate suggestion queueItemId: ${suggestion.queueItemId}`)
    }
    result.set(suggestion.queueItemId, suggestion)
  }
  return result
}

function createOperation(
  item: CurationQueueItem,
  suggestion: AiGlossSuggestion,
  opts: CliOptions
): CanonicalOverlayOperation {
  if (item.type !== 'missingGloss') throw new Error(`Unsupported queue item type: ${item.type}`)
  return createAiAddGlossOverlay({
    importedAt: opts.importedAt,
    model: opts.model,
    promptVersion: opts.promptVersion,
    inputRefs: item.inputRefs.length > 0 ? item.inputRefs : [item.id],
    senseId: item.senseId,
    lang: item.targetLang,
    text: suggestion.text,
  })
}

function pendingAiTargetKey(operation: CanonicalOverlayOperation): string | null {
  if (
    operation.sourceKind !== 'ai'
    || operation.reviewStatus !== 'unreviewed'
    || operation.type !== 'addGloss'
    || !operation.promptVersion
  ) return null

  return `${operation.type}:${operation.senseId}:${operation.lang}:${operation.promptVersion}`
}

function requireNoUnmatchedSuggestions(queue: CurationQueue, suggestions: AiGlossSuggestion[]): void {
  const queueItemIds = new Set(queue.items.map((item) => item.id))
  const unmatched = suggestions
    .map((suggestion) => suggestion.queueItemId)
    .filter((id) => !queueItemIds.has(id))

  if (unmatched.length > 0) {
    throw new Error(`Suggestions do not match queue items: ${unmatched.join(', ')}`)
  }
}

function assertCanWriteOperations(
  existing: CanonicalOverlayOperation[],
  operations: CanonicalOverlayOperation[]
): void {
  const existingIds = new Set(existing.map((operation) => operation.id))
  const existingPendingTargets = new Set(existing.map(pendingAiTargetKey).filter((key): key is string => Boolean(key)))
  const newIds = new Set<string>()
  const newPendingTargets = new Set<string>()

  for (const operation of operations) {
    if (existingIds.has(operation.id) || newIds.has(operation.id)) {
      throw new Error(`Overlay operation already exists: ${operation.id}`)
    }
    newIds.add(operation.id)

    const targetKey = pendingAiTargetKey(operation)
    if (!targetKey) continue
    if (existingPendingTargets.has(targetKey) || newPendingTargets.has(targetKey)) {
      throw new Error(`Pending AI overlay already exists for ${targetKey}`)
    }
    newPendingTargets.add(targetKey)
  }
}

export async function runCreateAiCurationOverlays(opts: CliOptions): Promise<CanonicalOverlayOperation[]> {
  const queue = await loadQueue(opts.queue)
  const suggestions = await loadSuggestions(opts.suggestions)
  if (suggestions.length === 0) throw new Error('No AI suggestions found')
  requireNoUnmatchedSuggestions(queue, suggestions)
  const suggestionsByQueueItemId = mapSuggestions(suggestions)
  const existing = await loadCanonicalOverlayFile(opts.overlay)

  const operations: CanonicalOverlayOperation[] = []
  for (const item of queue.items) {
    if (opts.limit && operations.length >= opts.limit) break

    const suggestion = suggestionsByQueueItemId.get(item.id)
    if (!suggestion) continue

    const operation = createOperation(item, suggestion, opts)
    operations.push(operation)
  }
  if (operations.length === 0) throw new Error('No AI suggestions matched queue items')

  assertCanWriteOperations(existing.operations, operations)
  await saveCanonicalOverlayFile(opts.overlay, {
    ...existing,
    operations: [...existing.operations, ...operations],
  })

  console.log('\n=== AI Curation Overlays ===')
  console.log(`Queue: ${opts.queue}`)
  console.log(`Suggestions: ${opts.suggestions}`)
  console.log(`Overlay: ${opts.overlay}`)
  console.log(`Operations created: ${operations.length.toLocaleString()}`)
  for (const operation of operations.slice(0, 10)) {
    console.log(`  - ${operation.id}\t${operation.type}\t${operation.reviewStatus}`)
  }

  return operations
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runCreateAiCurationOverlays(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
