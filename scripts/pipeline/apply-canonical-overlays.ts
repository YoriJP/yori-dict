import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  applyCanonicalOverlayFile,
  validateCanonicalOverlayFile,
  type CanonicalOverlayFile,
} from '../../src/domain/overlays'
import type { CanonicalSnapshot } from '../../src/domain/types'

interface CliOptions {
  snapshot: string
  overlay: string
  out: string
  registry: string
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'
const MAX_ERROR_DETAILS = 5

function formatIssueDetails(issues: Array<{ path: string; message: string }>): string {
  return issues
    .slice(0, MAX_ERROR_DETAILS)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ')
}

function printHelp(): void {
  console.log(`
Canonical overlay apply

Applies approved manual/AI overlay operations to a canonical snapshot.

Usage:
  bun run apply:canonical-overlays --overlay <overlays.json> [options]

Options:
  --overlay <path>    Overlay JSON file.
  --snapshot <path>   Existing canonical snapshot (default: ${DEFAULT_SNAPSHOT})
  --out <path>        Output snapshot path (default: same as --snapshot)
  --registry <path>   Stable Yori ID registry (default: ${DEFAULT_REGISTRY})
  --help, -h          Show this help.
`)
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    snapshot: DEFAULT_SNAPSHOT,
    overlay: '',
    out: DEFAULT_SNAPSHOT,
    registry: DEFAULT_REGISTRY,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--overlay' && next) {
      opts.overlay = next
      i++
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      opts.out = opts.out === DEFAULT_SNAPSHOT ? next : opts.out
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--registry' && next) {
      opts.registry = next
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!opts.overlay) throw new Error('--overlay is required')
  return opts
}

async function loadSnapshot(path: string): Promise<CanonicalSnapshot> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Canonical snapshot not found: ${path}`)
  return file.json() as Promise<CanonicalSnapshot>
}

async function loadOverlay(path: string): Promise<CanonicalOverlayFile> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Canonical overlay file not found: ${path}`)
  return file.json() as Promise<CanonicalOverlayFile>
}

export async function applyCanonicalOverlays(opts: CliOptions): Promise<void> {
  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadSnapshot(opts.snapshot)
  const overlay = await loadOverlay(opts.overlay)
  const overlayValidation = validateCanonicalOverlayFile(overlay)
  if (!overlayValidation.valid) {
    throw new Error(
      `Canonical overlay validation failed with ${overlayValidation.errors.length} error(s): ${
        formatIssueDetails(overlayValidation.errors)
      }`
    )
  }

  const result = applyCanonicalOverlayFile(snapshot, overlay, { registry })
  const snapshotValidation = validateCanonicalSnapshot(result.snapshot)
  if (!snapshotValidation.valid) {
    throw new Error(
      `Snapshot validation failed after overlays with ${snapshotValidation.errors.length} error(s): ${
        formatIssueDetails(snapshotValidation.errors)
      }`
    )
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, JSON.stringify(result.snapshot, null, 2) + '\n')
  await saveIdRegistry(opts.registry, registry)

  console.log('\n=== Canonical Overlay Apply ===')
  console.log(`Operations processed: ${result.stats.operationsProcessed.toLocaleString()}`)
  console.log(`Operations applied: ${result.stats.operationsApplied.toLocaleString()}`)
  console.log(`Operations skipped: ${result.stats.operationsSkipped.toLocaleString()}`)
  console.log(`Glosses added: ${result.stats.glossesAdded.toLocaleString()}`)
  console.log(`Examples added: ${result.stats.examplesAdded.toLocaleString()}`)
  console.log(`Entries upserted: ${result.stats.entriesUpserted.toLocaleString()}`)
  console.log(`Snapshot: ${opts.out}`)
  console.log(`Registry: ${opts.registry}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await applyCanonicalOverlays(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
