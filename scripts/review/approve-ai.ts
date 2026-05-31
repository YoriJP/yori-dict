import { Database } from 'bun:sqlite'
import { initUpdatesDatabase, recordAdminAction } from '../../src/update-store'

export interface ApproveAiOptions {
  all: boolean
  batchId: number | null
  langs: string[] | null
  actor: string
  notes: string
  dryRun: boolean
  includeTranslations: boolean
  includeExamples: boolean
}

export interface ApproveAiResult {
  dryRun: boolean
  filters: {
    all: boolean
    batchId: number | null
    langs: string[] | null
    includeTranslations: boolean
    includeExamples: boolean
  }
  translations: number
  exampleSets: number
}

interface CountRow {
  count: number
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseLangs(value: string): string[] {
  const langs = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (langs.length === 0) throw new Error('--langs must include at least one language')
  return [...new Set(langs)]
}

function parseArgs(args: string[]): ApproveAiOptions {
  const options: ApproveAiOptions = {
    all: false,
    batchId: null,
    langs: null,
    actor: 'bulk-approve',
    notes: 'bulk approved via script',
    dryRun: false,
    includeTranslations: true,
    includeExamples: true,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--all') {
      options.all = true
    } else if (arg === '--batch-id' && next) {
      options.batchId = parsePositiveInt(next, '--batch-id')
      i++
    } else if ((arg === '--langs' || arg === '--lang') && next) {
      options.langs = parseLangs(next)
      i++
    } else if (arg === '--actor' && next) {
      options.actor = next
      i++
    } else if (arg === '--notes' && next) {
      options.notes = next
      i++
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--translations-only') {
      options.includeTranslations = true
      options.includeExamples = false
    } else if (arg === '--examples-only') {
      options.includeTranslations = false
      options.includeExamples = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  validateOptions(options)
  return options
}

function validateOptions(options: ApproveAiOptions): void {
  const hasFilter = options.batchId !== null || options.langs !== null
  if (!options.all && !hasFilter) {
    throw new Error('Refusing to approve without a filter. Use --batch-id, --langs, or explicit --all.')
  }
  if (options.all && hasFilter) {
    throw new Error('Use either --all or filters, not both.')
  }
  if (!options.includeTranslations && !options.includeExamples) {
    throw new Error('Nothing to approve.')
  }
}

function printHelp(): void {
  console.log(`
Approve pending AI review updates in updates.sqlite.

Usage:
  bun run review:approve-ai --batch-id <id> [--langs zh-tw,ko] [--dry-run]
  bun run review:approve-ai --langs zh-tw --dry-run
  bun run review:approve-ai --all --dry-run
  bun run review:approve-ai --all

Options:
  --batch-id <id>       Approve only one AI import batch
  --langs <list>        Comma-separated languages, e.g. de,ko,zh-cn,zh-tw
  --all                 Approve every pending active AI update
  --dry-run             Show matching counts without writing
  --actor <name>        reviewed_by value (default: bulk-approve)
  --notes <text>        review_notes value
  --translations-only   Approve translation_updates only
  --examples-only       Approve example_update_sets only
`)
}

function buildWhere(options: ApproveAiOptions): { sql: string; params: Array<string | number> } {
  const clauses = [
    `source_type = 'ai'`,
    `status = 'active'`,
    `review_status = 'pending'`,
  ]
  const params: Array<string | number> = []

  if (options.batchId !== null) {
    params.push(options.batchId)
    clauses.push('batch_id = ?')
  }

  if (options.langs !== null) {
    const placeholders = options.langs.map((lang) => {
      params.push(lang)
      return '?'
    })
    clauses.push(`lang IN (${placeholders.join(', ')})`)
  }

  return {
    sql: clauses.join(' AND '),
    params,
  }
}

function countRows(db: Database, table: string, whereSql: string, params: Array<string | number>): number {
  const row = db.query<CountRow, Array<string | number>>(`
    SELECT COUNT(*) AS count
    FROM ${table}
    WHERE ${whereSql}
  `).get(...params)

  return row?.count ?? 0
}

function approveRows(
  db: Database,
  table: string,
  whereSql: string,
  params: Array<string | number>,
  actor: string,
  notes: string,
  reviewedAt: string,
): number {
  const result = db.prepare(`
    UPDATE ${table}
    SET review_status = 'approved',
        reviewed_at = ?1,
        reviewed_by = ?2,
        review_notes = ?3
    WHERE ${whereSql}
  `).run(reviewedAt, actor, notes, ...params)

  return result.changes
}

export function approvePendingAiReviews(
  db: Database,
  options: ApproveAiOptions,
): ApproveAiResult {
  validateOptions(options)
  const where = buildWhere(options)

  const translations = options.includeTranslations
    ? countRows(db, 'translation_updates', where.sql, where.params)
    : 0
  const exampleSets = options.includeExamples
    ? countRows(db, 'example_update_sets', where.sql, where.params)
    : 0

  if (!options.dryRun) {
    const reviewedAt = new Date().toISOString()
    db.transaction(() => {
      if (options.includeTranslations) {
        approveRows(db, 'translation_updates', where.sql, where.params, options.actor, options.notes, reviewedAt)
      }
      if (options.includeExamples) {
        approveRows(db, 'example_update_sets', where.sql, where.params, options.actor, options.notes, reviewedAt)
      }
      recordAdminAction(db, {
        actor: options.actor,
        action: 'review.ai.bulk-approve',
        targetKind: 'ai-review-filter',
        targetId: JSON.stringify({
          all: options.all,
          batchId: options.batchId,
          langs: options.langs,
          includeTranslations: options.includeTranslations,
          includeExamples: options.includeExamples,
        }),
        notes: `${options.notes} (${translations} translations, ${exampleSets} example sets)`,
      })
    })()
  }

  return {
    dryRun: options.dryRun,
    filters: {
      all: options.all,
      batchId: options.batchId,
      langs: options.langs,
      includeTranslations: options.includeTranslations,
      includeExamples: options.includeExamples,
    },
    translations,
    exampleSets,
  }
}

function printResult(result: ApproveAiResult): void {
  console.log('=== Bulk AI Review Approval ===')
  console.log(`Mode: ${result.dryRun ? 'dry run' : 'write'}`)
  console.log(`All: ${result.filters.all ? 'yes' : 'no'}`)
  console.log(`Batch ID: ${result.filters.batchId ?? 'any'}`)
  console.log(`Languages: ${result.filters.langs?.join(', ') ?? 'any'}`)
  console.log(`Translations matched: ${result.translations.toLocaleString()}`)
  console.log(`Example sets matched: ${result.exampleSets.toLocaleString()}`)
  if (result.dryRun) {
    console.log('No rows were changed.')
  } else {
    console.log('Matching pending AI rows were marked approved.')
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const db = initUpdatesDatabase()
  try {
    const result = approvePendingAiReviews(db, options)
    printResult(result)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Bulk AI approval failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
