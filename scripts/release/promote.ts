import { Database } from 'bun:sqlite'
import {
  buildReleaseVersion,
  requireActiveReleaseConfig,
  writeCurrentReleasePointer,
  writeReleaseManifest,
  getReleaseDbPath,
  getReleaseManifestPath,
} from '../../src/storage'
import { loadSnapshotFromReleaseDb, applyActiveUpdatesToSnapshot, writeReleaseSnapshotToDb } from './lib'
import { initUpdatesDatabase, markAllActiveUpdatesPromoted } from '../../src/update-store'

interface PromoteOptions {
  version: string | null
  activate: boolean
}

function parseArgs(args: string[]): PromoteOptions {
  const options: PromoteOptions = {
    version: null,
    activate: true,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--version' && next) {
      options.version = next
      i++
    } else if (arg === '--no-activate') {
      options.activate = false
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
Promote active updates into a new immutable release.

Usage:
  bun run release:promote [--version <version>] [--no-activate]
`)
}

function getPromotedFromUpdateSequence(db: Database): number | null {
  const row = db.query<{ max_id: number | null }, []>(`
    SELECT MAX(batch_id) AS max_id
    FROM (
      SELECT batch_id FROM translation_updates WHERE status = 'active'
      UNION ALL
      SELECT batch_id FROM example_update_sets WHERE status = 'active'
    )
  `).get()

  return row?.max_id ?? null
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const activeRelease = requireActiveReleaseConfig()
  const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
  const updatesDb = initUpdatesDatabase()

  const promotedFromUpdateSequence = getPromotedFromUpdateSequence(updatesDb)
  const snapshot = loadSnapshotFromReleaseDb(releaseDb)
  const mergedSnapshot = applyActiveUpdatesToSnapshot(snapshot, updatesDb)

  const version = options.version || buildReleaseVersion()
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  writeReleaseSnapshotToDb(dbPath, mergedSnapshot)
  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: `promoted-from:${activeRelease.version}`,
    releaseDbPath: dbPath,
    promotedFromUpdateSequence,
  })

  markAllActiveUpdatesPromoted(updatesDb)

  if (options.activate) {
    writeCurrentReleasePointer({
      version,
      dbPath,
      manifestPath,
      activatedAt: new Date().toISOString(),
    })
  }

  releaseDb.close()
  updatesDb.close()

  console.log(`Promoted release: ${version}`)
  console.log(`Release DB: ${dbPath}`)
  if (options.activate) {
    console.log('Release activated.')
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Release promote failed:', error)
    process.exit(1)
  })
}
