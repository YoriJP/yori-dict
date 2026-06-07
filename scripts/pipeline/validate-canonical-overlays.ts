import { existsSync } from 'fs'
import { loadIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import {
  applyCanonicalOverlayFile,
  validateCanonicalOverlayFile,
  type CanonicalOverlayFile,
} from '../../src/domain/overlays'
import type { CanonicalSnapshot } from '../../src/domain/types'

interface CliOptions {
  overlay: string
  snapshot?: string
  registry: string
}

const DEFAULT_REGISTRY = 'data/registry/ids.json'
const MAX_ERROR_DETAILS = 5

function printHelp(): void {
  console.log(`
Canonical overlay validation

Validates canonical overlay JSON and optionally checks that approved operations
apply cleanly to a canonical snapshot without writing files.

Usage:
  bun run validate:canonical-overlays --overlay <overlays.json> [options]

Options:
  --overlay <path>    Overlay JSON file.
  --snapshot <path>   Canonical snapshot JSON. Enables apply validation.
  --registry <path>   Stable Yori ID registry for apply validation (default: ${DEFAULT_REGISTRY})
  --help, -h          Show this help.
`)
}

function formatIssueDetails(issues: Array<{ path: string; message: string }>): string {
  return issues
    .slice(0, MAX_ERROR_DETAILS)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ')
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    overlay: '',
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

async function loadJsonFile<T>(path: string, label: string): Promise<T> {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`)
  return Bun.file(path).json() as Promise<T>
}

export async function validateCanonicalOverlays(opts: CliOptions): Promise<void> {
  const overlay = await loadJsonFile<CanonicalOverlayFile>(opts.overlay, 'Canonical overlay file')
  const overlayValidation = validateCanonicalOverlayFile(overlay)
  if (!overlayValidation.valid) {
    throw new Error(
      `Canonical overlay validation failed with ${overlayValidation.errors.length} error(s): ${
        formatIssueDetails(overlayValidation.errors)
      }`
    )
  }

  console.log('\n=== Canonical Overlay Validation ===')
  console.log(`Overlay: ${opts.overlay}`)
  console.log(`Operations: ${overlay.operations.length.toLocaleString()}`)

  if (!opts.snapshot) {
    console.log('Apply validation: skipped')
    return
  }

  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadJsonFile<CanonicalSnapshot>(opts.snapshot, 'Canonical snapshot')
  const result = applyCanonicalOverlayFile(snapshot, overlay, { registry })
  const snapshotValidation = validateCanonicalSnapshot(result.snapshot)
  if (!snapshotValidation.valid) {
    throw new Error(
      `Snapshot validation failed after overlays with ${snapshotValidation.errors.length} error(s): ${
        formatIssueDetails(snapshotValidation.errors)
      }`
    )
  }

  const approvedCount = overlay.operations
    .filter((operation) => operation.reviewStatus === 'approved')
    .length
  if (result.stats.operationsApplied !== approvedCount) {
    throw new Error(
      `Approved overlay apply check failed: ${result.stats.operationsApplied} applied, ${approvedCount} approved`
    )
  }

  console.log(`Snapshot: ${opts.snapshot}`)
  console.log(`Registry: ${opts.registry}`)
  console.log(`Approved operations: ${approvedCount.toLocaleString()}`)
  console.log(`Operations applied: ${result.stats.operationsApplied.toLocaleString()}`)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await validateCanonicalOverlays(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
