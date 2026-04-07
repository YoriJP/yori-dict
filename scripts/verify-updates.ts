import { Database } from 'bun:sqlite'
import { requireActiveReleaseConfig } from '../src/storage'
import { initUpdatesDatabase, verifyUpdatesAgainstWordIds } from '../src/update-store'
import { loadSnapshotFromReleaseDb } from './release/lib'

async function main(): Promise<void> {
  const activeRelease = requireActiveReleaseConfig()
  const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
  const updatesDb = initUpdatesDatabase()

  const snapshot = loadSnapshotFromReleaseDb(releaseDb)
  const summary = verifyUpdatesAgainstWordIds(updatesDb, new Set(snapshot.words.keys()))

  console.log('=== Update Verification ===')
  console.log(`Active release: ${activeRelease.version}`)
  console.log(`Translation update counts: ${JSON.stringify(summary.translationCounts)}`)
  console.log(`Example update set counts: ${JSON.stringify(summary.exampleSetCounts)}`)
  console.log(`Orphaned word IDs: ${summary.orphanedWordIds.length.toLocaleString()}`)

  if (summary.orphanedWordIds.length > 0) {
    for (const wordId of summary.orphanedWordIds.slice(0, 20)) {
      console.log(`  - ${wordId}`)
    }
    if (summary.orphanedWordIds.length > 20) {
      console.log(`  ... and ${summary.orphanedWordIds.length - 20} more`)
    }
    process.exitCode = 1
  }

  releaseDb.close()
  updatesDb.close()
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Update verification failed:', error)
    process.exit(1)
  })
}

