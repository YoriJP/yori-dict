import {
  appendCanonicalOverlayOperation,
  listPendingAiOverlayOperations,
  loadCanonicalOverlayFile,
  updateCanonicalOverlayOperation,
} from '../../src/domain/overlay-store'
import {
  approveOverlayOperation,
  createManualAddExampleOverlay,
  createManualAddGlossOverlay,
  createManualReplaceGlossesOverlay,
  rejectOverlayOperation,
  type CanonicalOverlayOperation,
} from '../../src/domain/overlays'
import type { ReviewStatus, TargetLanguage } from '../../src/domain/types'
import { normalizeLanguage, SUPPORTED_LANGUAGES } from '../../src/types'

type Command =
  | 'add-gloss'
  | 'replace-glosses'
  | 'add-example'
  | 'approve'
  | 'reject'
  | 'list-pending-ai'

export interface CliOptions {
  command: Command
  overlay: string
  importedAt: string
  id?: string
  senseId?: string
  lang?: TargetLanguage
  text?: string
  glosses: string[]
  japanese?: string
  translation?: string
  approved: boolean
}

const DEFAULT_OVERLAY = 'data/overlays/canonical-overlays.json'

function printHelp(): void {
  console.log(`
Canonical overlay curation

Creates and reviews canonical overlay operations. This is an internal file-based
tool, not an admin server.

Usage:
  bun run curate:canonical-overlays <command> [options]

Commands:
  add-gloss         Create a manual addGloss operation.
  replace-glosses  Create a manual replaceGlosses operation.
  add-example       Create a manual addExample operation.
  approve           Mark an operation approved.
  reject            Mark an operation rejected.
  list-pending-ai   List unreviewed AI operations.

Common options:
  --overlay <path>      Overlay file (default: ${DEFAULT_OVERLAY})
  --id <id>             Operation ID. Required for approve/reject, optional for create commands.
  --imported-at <iso>   Creation timestamp (default: now)
  --approved            Create a manual operation as approved.
  --help, -h            Show this help.

Create options:
  --sense-id <id>       Target sense ID.
  --lang <lang>         Target language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}
  --text <text>         Gloss text for add-gloss.
  --gloss <text>        Replacement gloss text. Repeat for replace-glosses.
  --japanese <text>     Japanese example sentence.
  --translation <text>  Example translation.
`)
}

function parseLang(value: string): TargetLanguage {
  const lang = normalizeLanguage(value)
  if (!lang) throw new Error(`--lang must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
  return lang
}

function reviewStatus(approved: boolean): ReviewStatus {
  return approved ? 'approved' : 'unreviewed'
}

function requireString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value
}

function requireLang(value: TargetLanguage | undefined): TargetLanguage {
  if (!value) throw new Error('--lang is required')
  return value
}

export function parseArgs(args: string[]): CliOptions {
  const rawCommand = args[0]
  if (!rawCommand || rawCommand === '--help' || rawCommand === '-h') {
    printHelp()
    process.exit(0)
  }

  if (!isCommand(rawCommand)) {
    throw new Error(`Unknown command: ${rawCommand}`)
  }

  const opts: CliOptions = {
    command: rawCommand,
    overlay: DEFAULT_OVERLAY,
    importedAt: new Date().toISOString(),
    glosses: [],
    approved: false,
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--overlay' && next) {
      opts.overlay = next
      i++
    } else if (arg === '--id' && next) {
      opts.id = next
      i++
    } else if (arg === '--imported-at' && next) {
      opts.importedAt = next
      i++
    } else if (arg === '--sense-id' && next) {
      opts.senseId = next
      i++
    } else if (arg === '--lang' && next) {
      opts.lang = parseLang(next)
      i++
    } else if (arg === '--text' && next) {
      opts.text = next
      i++
    } else if (arg === '--gloss' && next) {
      opts.glosses.push(next)
      i++
    } else if (arg === '--japanese' && next) {
      opts.japanese = next
      i++
    } else if (arg === '--translation' && next) {
      opts.translation = next
      i++
    } else if (arg === '--approved') {
      opts.approved = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

function isCommand(value: string): value is Command {
  return [
    'add-gloss',
    'replace-glosses',
    'add-example',
    'approve',
    'reject',
    'list-pending-ai',
  ].includes(value)
}

function describeOperation(operation: CanonicalOverlayOperation): string {
  if (operation.type === 'upsertEntry') {
    return `${operation.id}\t${operation.type}\t${operation.entry.id}`
  }
  return `${operation.id}\t${operation.type}\t${operation.lang}\t${operation.senseId}`
}

export async function runCurationCommand(opts: CliOptions): Promise<CanonicalOverlayOperation | CanonicalOverlayOperation[]> {
  if (opts.command === 'add-gloss') {
    const operation = createManualAddGlossOverlay({
      id: opts.id,
      importedAt: opts.importedAt,
      reviewStatus: reviewStatus(opts.approved),
      senseId: requireString(opts.senseId, '--sense-id'),
      lang: requireLang(opts.lang),
      text: requireString(opts.text, '--text'),
    })
    await appendCanonicalOverlayOperation(opts.overlay, operation)
    console.log(`Created: ${operation.id}`)
    return operation
  }

  if (opts.command === 'replace-glosses') {
    if (opts.glosses.length === 0) throw new Error('--gloss is required')
    const operation = createManualReplaceGlossesOverlay({
      id: opts.id,
      importedAt: opts.importedAt,
      reviewStatus: reviewStatus(opts.approved),
      senseId: requireString(opts.senseId, '--sense-id'),
      lang: requireLang(opts.lang),
      glosses: opts.glosses,
    })
    await appendCanonicalOverlayOperation(opts.overlay, operation)
    console.log(`Created: ${operation.id}`)
    return operation
  }

  if (opts.command === 'add-example') {
    const operation = createManualAddExampleOverlay({
      id: opts.id,
      importedAt: opts.importedAt,
      reviewStatus: reviewStatus(opts.approved),
      senseId: requireString(opts.senseId, '--sense-id'),
      lang: requireLang(opts.lang),
      japanese: requireString(opts.japanese, '--japanese'),
      translation: requireString(opts.translation, '--translation'),
    })
    await appendCanonicalOverlayOperation(opts.overlay, operation)
    console.log(`Created: ${operation.id}`)
    return operation
  }

  if (opts.command === 'approve') {
    const operation = await updateCanonicalOverlayOperation(
      opts.overlay,
      requireString(opts.id, '--id'),
      approveOverlayOperation
    )
    console.log(`Approved: ${operation.id}`)
    return operation
  }

  if (opts.command === 'reject') {
    const operation = await updateCanonicalOverlayOperation(
      opts.overlay,
      requireString(opts.id, '--id'),
      rejectOverlayOperation
    )
    console.log(`Rejected: ${operation.id}`)
    return operation
  }

  const file = await loadCanonicalOverlayFile(opts.overlay)
  const operations = listPendingAiOverlayOperations(file)
  for (const operation of operations) console.log(describeOperation(operation))
  return operations
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runCurationCommand(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
