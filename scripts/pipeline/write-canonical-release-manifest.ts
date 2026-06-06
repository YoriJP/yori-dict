import { createHash } from 'crypto'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import type { CanonicalSnapshot } from '../../src/domain/types'

interface ArtifactRef {
  path: string
  sha256: string
  bytes: number
}

interface SourceArtifactRef extends ArtifactRef {
  kind: string
}

export interface CanonicalReleaseManifest {
  schemaVersion: '1.0.0'
  generatedAt: string
  releaseVersion?: string
  artifacts: {
    snapshot: ArtifactRef
    releaseDb: ArtifactRef
    overlays: ArtifactRef[]
    qualityReport?: ArtifactRef
    sources: SourceArtifactRef[]
  }
  summary: {
    entries: number
    lookupAliases: number
    kanjiCharacters: number
  }
}

interface CliOptions {
  snapshot: string
  releaseDb: string
  overlays: string[]
  qualityReport?: string
  sources: Array<{ kind: string; path: string }>
  out: string
  generatedAt: string
  releaseVersion?: string
}

const DEFAULT_SNAPSHOT = 'data/snapshots/yori-dict.snapshot.json'
const DEFAULT_RELEASE_DB = 'data/releases/canonical/yori-dict.sqlite'
const DEFAULT_OUT = 'data/releases/canonical/manifest.json'

function printHelp(): void {
  console.log(`
Canonical release manifest

Writes a manifest with hashes and metadata for canonical release artifacts.

Usage:
  bun run release:manifest:canonical [options]

Options:
  --snapshot <path>          Canonical snapshot JSON (default: ${DEFAULT_SNAPSHOT})
  --release-db <path>        Canonical SQLite release DB (default: ${DEFAULT_RELEASE_DB})
  --overlay <path>           Overlay JSON file included in the release. Repeatable.
  --quality-report <path>    Quality report JSON path.
  --source <kind=path>       Source artifact included in the release. Repeatable.
  --out <path>               Manifest output path (default: ${DEFAULT_OUT})
  --generated-at <iso>       Manifest timestamp (default: now)
  --release-version <value>  Optional release version label.
  --help, -h                 Show this help.
`)
}

function parseSource(value: string): { kind: string; path: string } {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--source must use kind=path')
  }
  return {
    kind: value.slice(0, separator),
    path: value.slice(separator + 1),
  }
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    snapshot: DEFAULT_SNAPSHOT,
    releaseDb: DEFAULT_RELEASE_DB,
    overlays: [],
    sources: [],
    out: DEFAULT_OUT,
    generatedAt: new Date().toISOString(),
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--snapshot' && next) {
      opts.snapshot = next
      i++
    } else if (arg === '--release-db' && next) {
      opts.releaseDb = next
      i++
    } else if (arg === '--overlay' && next) {
      opts.overlays.push(next)
      i++
    } else if (arg === '--quality-report' && next) {
      opts.qualityReport = next
      i++
    } else if (arg === '--source' && next) {
      opts.sources.push(parseSource(next))
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--generated-at' && next) {
      opts.generatedAt = next
      i++
    } else if (arg === '--release-version' && next) {
      opts.releaseVersion = next
      i++
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return opts
}

async function hashFile(path: string): Promise<ArtifactRef> {
  if (!existsSync(path)) throw new Error(`Artifact not found: ${path}`)
  const hasher = createHash('sha256')
  hasher.update(Buffer.from(await Bun.file(path).arrayBuffer()))
  return {
    path,
    sha256: hasher.digest('hex'),
    bytes: statSync(path).size,
  }
}

async function readSnapshotSummary(path: string): Promise<CanonicalReleaseManifest['summary']> {
  if (!existsSync(path)) throw new Error(`Snapshot not found: ${path}`)
  const snapshot = await Bun.file(path).json() as CanonicalSnapshot
  return {
    entries: snapshot.entries.length,
    lookupAliases: snapshot.lookupAliases.length,
    kanjiCharacters: (snapshot.kanjiCharacters ?? []).length,
  }
}

export async function writeCanonicalReleaseManifest(opts: CliOptions): Promise<CanonicalReleaseManifest> {
  const snapshot = await hashFile(opts.snapshot)
  const releaseDb = await hashFile(opts.releaseDb)
  const overlays = await Promise.all(opts.overlays.map((path) => hashFile(path)))
  const qualityReport = opts.qualityReport ? await hashFile(opts.qualityReport) : undefined
  const sources = await Promise.all(opts.sources.map(async (source) => ({
    kind: source.kind,
    ...await hashFile(source.path),
  })))

  const manifest: CanonicalReleaseManifest = {
    schemaVersion: '1.0.0',
    generatedAt: opts.generatedAt,
    releaseVersion: opts.releaseVersion,
    artifacts: {
      snapshot,
      releaseDb,
      overlays,
      qualityReport,
      sources,
    },
    summary: await readSnapshotSummary(opts.snapshot),
  }

  mkdirSync(dirname(opts.out), { recursive: true })
  await Bun.write(opts.out, JSON.stringify(manifest, null, 2) + '\n')

  console.log('\n=== Canonical Release Manifest ===')
  console.log(`Manifest: ${opts.out}`)
  console.log(`Snapshot: ${opts.snapshot}`)
  console.log(`Release DB: ${opts.releaseDb}`)
  console.log(`Overlays: ${overlays.length.toLocaleString()}`)
  console.log(`Sources: ${sources.length.toLocaleString()}`)

  return manifest
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await writeCanonicalReleaseManifest(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
