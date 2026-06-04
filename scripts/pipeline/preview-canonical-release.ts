import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  applyCanonicalOverlayFile,
  validateCanonicalOverlayFile,
  type CanonicalOverlayFile,
} from '../../src/domain/overlays'
import { loadIdRegistry, saveIdRegistry } from '../../src/domain/registry-store'
import { validateCanonicalSnapshot } from '../../src/domain/validate'
import { CanonicalLookupService } from '../../src/runtime/canonical-lookup'
import { buildCanonicalRelease } from './build-canonical-release'
import type { CanonicalSnapshot, Entry, TargetLanguage } from '../../src/domain/types'

interface CliOptions {
  snapshot: string
  overlay: string
  registry: string
  outDir: string
  lang: TargetLanguage
  lookups: string[]
  entryIds: string[]
  overwrite: boolean
}

interface PreviewSummary {
  snapshot: string
  releaseDb: string
  registry: string
  touchedEntryIds: string[]
  lookupsChecked: number
  entriesChecked: number
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_REGISTRY = 'data/registry/ids.json'
const DEFAULT_OUT_DIR = 'data/previews/canonical-release'
const DEFAULT_LANG: TargetLanguage = 'en'
const SUPPORTED_LANGS = new Set<TargetLanguage>(['en', 'de', 'ko', 'zh-cn', 'zh-tw'])
const MAX_ERROR_DETAILS = 5

function printHelp(): void {
  console.log(`
Canonical release preview

Applies approved manual/AI overlays to a preview snapshot, builds a temporary
canonical release DB, and runs focused smoke checks without promoting anything.

Usage:
  bun run preview:canonical-release --overlay <overlays.json> [options]

Options:
  --overlay <path>    Overlay JSON file.
  --snapshot <path>   Existing canonical snapshot (default: ${DEFAULT_SNAPSHOT})
  --registry <path>   Stable Yori ID registry (default: ${DEFAULT_REGISTRY})
  --out-dir <path>    Preview output directory (default: ${DEFAULT_OUT_DIR})
  --lang <lang>       Smoke-check language (default: ${DEFAULT_LANG})
  --lookup <query>    Lookup query to smoke test. Repeatable.
  --entry-id <id>     Entry ID to smoke test. Repeatable.
  --overwrite         Replace an existing preview output directory.
  --help, -h          Show this help.
`)
}

function formatIssueDetails(issues: Array<{ path: string; message: string }>): string {
  return issues
    .slice(0, MAX_ERROR_DETAILS)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ')
}

function parseLang(value: string): TargetLanguage {
  if (SUPPORTED_LANGS.has(value as TargetLanguage)) return value as TargetLanguage
  throw new Error(`Unsupported language: ${value}`)
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    snapshot: DEFAULT_SNAPSHOT,
    overlay: '',
    registry: DEFAULT_REGISTRY,
    outDir: DEFAULT_OUT_DIR,
    lang: DEFAULT_LANG,
    lookups: [],
    entryIds: [],
    overwrite: false,
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
    } else if (arg === '--out-dir' && next) {
      opts.outDir = next
      i++
    } else if (arg === '--lang' && next) {
      opts.lang = parseLang(next)
      i++
    } else if (arg === '--lookup' && next) {
      opts.lookups.push(next)
      i++
    } else if (arg === '--entry-id' && next) {
      opts.entryIds.push(next)
      i++
    } else if (arg === '--overwrite') {
      opts.overwrite = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!opts.overlay) throw new Error('--overlay is required')
  return opts
}

async function loadJsonFile<T>(path: string, label: string): Promise<T> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`${label} not found: ${path}`)
  return file.json() as Promise<T>
}

function collectSenseOwners(snapshot: CanonicalSnapshot): Map<string, Entry> {
  const owners = new Map<string, Entry>()
  for (const entry of snapshot.entries) {
    for (const sense of entry.senses) owners.set(sense.id, entry)
  }
  return owners
}

function collectTouchedEntryIds(snapshot: CanonicalSnapshot, overlay: CanonicalOverlayFile): string[] {
  const senseOwners = collectSenseOwners(snapshot)
  const ids = new Set<string>()

  for (const op of overlay.operations) {
    if (op.reviewStatus !== 'approved') continue
    if (op.type === 'upsertEntry') {
      ids.add(op.entry.id)
      continue
    }

    const owner = senseOwners.get(op.senseId)
    if (owner) ids.add(owner.id)
  }

  return [...ids].sort()
}

function prepareOutDir(outDir: string, overwrite: boolean): void {
  if (existsSync(outDir)) {
    if (!overwrite) throw new Error(`Preview output directory already exists: ${outDir}. Use --overwrite to replace it.`)
    rmSync(outDir, { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })
}

function smokeCheckEntry(service: CanonicalLookupService, entryId: string, lang: TargetLanguage): void {
  const entry = service.getEntry(entryId, lang)
  if (!entry) throw new Error(`Preview smoke check failed: entry not found: ${entryId}`)
}

function smokeCheckLookup(service: CanonicalLookupService, query: string, lang: TargetLanguage): void {
  const result = service.lookup({ query, lang, limit: 3 })
  if (result.entries.length === 0) {
    throw new Error(`Preview smoke check failed: lookup returned no entries: ${query}`)
  }
}

export async function previewCanonicalRelease(opts: CliOptions): Promise<PreviewSummary> {
  prepareOutDir(opts.outDir, opts.overwrite)

  const previewSnapshotPath = join(opts.outDir, 'snapshot.preview.json')
  const previewRegistryPath = join(opts.outDir, 'ids.preview.json')
  const previewReleasePath = join(opts.outDir, 'release.preview.sqlite')

  const registry = await loadIdRegistry(opts.registry)
  const snapshot = await loadJsonFile<CanonicalSnapshot>(opts.snapshot, 'Canonical snapshot')
  const overlay = await loadJsonFile<CanonicalOverlayFile>(opts.overlay, 'Canonical overlay file')

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

  const touchedEntryIds = collectTouchedEntryIds(result.snapshot, overlay)
  const entryIds = [...new Set([...touchedEntryIds, ...opts.entryIds])]

  await Bun.write(previewSnapshotPath, JSON.stringify(result.snapshot, null, 2) + '\n')
  await saveIdRegistry(previewRegistryPath, registry)
  await buildCanonicalRelease({
    snapshot: previewSnapshotPath,
    out: previewReleasePath,
    overwrite: true,
  })

  const db = new Database(previewReleasePath, { readonly: true })
  try {
    const service = new CanonicalLookupService(db)
    for (const entryId of entryIds) smokeCheckEntry(service, entryId, opts.lang)
    for (const query of opts.lookups) smokeCheckLookup(service, query, opts.lang)
  } finally {
    db.close()
  }

  console.log('\n=== Canonical Release Preview ===')
  console.log(`Snapshot: ${previewSnapshotPath}`)
  console.log(`Release DB: ${previewReleasePath}`)
  console.log(`Registry: ${previewRegistryPath}`)
  console.log(`Touched entries: ${touchedEntryIds.length.toLocaleString()}`)
  console.log(`Entry smoke checks: ${entryIds.length.toLocaleString()}`)
  console.log(`Lookup smoke checks: ${opts.lookups.length.toLocaleString()}`)

  return {
    snapshot: previewSnapshotPath,
    releaseDb: previewReleasePath,
    registry: previewRegistryPath,
    touchedEntryIds,
    lookupsChecked: opts.lookups.length,
    entriesChecked: entryIds.length,
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await previewCanonicalRelease(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
