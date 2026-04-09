import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'fs'
import {
  buildReleaseVersion,
  computeFingerprintForFiles,
  getReleaseDbPath,
  getReleaseManifestPath,
  readCurrentReleasePointer,
  readReleaseManifest,
  RELEASES_DIR,
  requireActiveReleaseConfig,
  writeCurrentReleasePointer,
  writeReleaseManifest,
} from './storage'
import { initUpdatesDatabase, markAllActiveUpdatesPromoted, recordAdminAction } from './update-store'
import {
  applyActiveUpdatesToSnapshot,
  collectSnapshotSourceFiles,
  loadSnapshotFromJson,
  loadSnapshotFromReleaseDb,
  writeReleaseSnapshotToDb,
} from '../scripts/release/lib'

export interface BuildReleaseOptions {
  version?: string | null
  activate?: boolean
  actor?: string | null
}

export interface PromoteReleaseOptions {
  version?: string | null
  activate?: boolean
  actor?: string | null
}

export interface ReleaseActionResult {
  version: string
  dbPath: string
  manifestPath: string
  activated: boolean
}

export interface ReleaseListItem {
  version: string
  dbPath: string
  manifestPath: string
  builtAt: string
  schemaVersion: string
  baseSourceFingerprint: string
  promotedFromUpdateSequence: number | null
  isActive: boolean
}

function collectFingerprintFiles(): string[] {
  return collectSnapshotSourceFiles()
}

function releaseArtifactsExist(dbPath: string, manifestPath: string): boolean {
  if (existsSync(manifestPath)) return true
  return ['', '-wal', '-shm'].some((suffix) => existsSync(dbPath + suffix))
}

function assertReleaseVersionAvailable(version: string, dbPath: string, manifestPath: string): void {
  if (!releaseArtifactsExist(dbPath, manifestPath)) return
  throw new Error(`Release version already exists: ${version}`)
}

function getPromotedFromUpdateSequence(db: Database): number | null {
  const row = db.query<{ max_id: number | null }, []>(`
    SELECT MAX(batch_id) AS max_id
    FROM (
      SELECT batch_id FROM translation_updates
      WHERE status = 'active' AND (source_type = 'source' OR review_status = 'approved')
      UNION ALL
      SELECT batch_id FROM example_update_sets
      WHERE status = 'active' AND (source_type = 'source' OR review_status = 'approved')
    )
  `).get()

  return row?.max_id ?? null
}

function maybeRecordAdminAction(
  action: string,
  targetId: string,
  actor?: string | null,
  notes?: string | null
): void {
  if (!actor) return
  const updatesDb = initUpdatesDatabase()
  recordAdminAction(updatesDb, {
    actor,
    action,
    targetKind: 'release',
    targetId,
    notes,
  })
  updatesDb.close()
}

export async function buildRelease(options: BuildReleaseOptions = {}): Promise<ReleaseActionResult> {
  const snapshot = await loadSnapshotFromJson()
  const fingerprint = computeFingerprintForFiles(collectFingerprintFiles())
  const version = options.version ?? buildReleaseVersion(new Date(), fingerprint)
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  assertReleaseVersionAvailable(version, dbPath, manifestPath)
  writeReleaseSnapshotToDb(dbPath, snapshot)
  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: fingerprint,
    releaseDbPath: dbPath,
    promotedFromUpdateSequence: null,
  })

  if (options.activate) {
    writeCurrentReleasePointer({
      version,
      dbPath,
      manifestPath,
      activatedAt: new Date().toISOString(),
    })
  }

  maybeRecordAdminAction(
    options.activate ? 'release.build_and_activate' : 'release.build',
    version,
    options.actor,
  )

  return {
    version,
    dbPath,
    manifestPath,
    activated: options.activate === true,
  }
}

export async function buildReleaseForNewWord(
  wordId: string,
  options: BuildReleaseOptions = {}
): Promise<ReleaseActionResult> {
  const jsonSnapshot = await loadSnapshotFromJson()
  if (!jsonSnapshot.words.has(wordId)) {
    throw new Error(`Word not found in snapshot: ${wordId}`)
  }

  const fingerprint = computeFingerprintForFiles(collectFingerprintFiles())
  const version = options.version ?? buildReleaseVersion(new Date(), fingerprint)
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  assertReleaseVersionAvailable(version, dbPath, manifestPath)
  writeReleaseSnapshotToDb(dbPath, jsonSnapshot)
  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: fingerprint,
    releaseDbPath: dbPath,
    promotedFromUpdateSequence: null,
  })

  if (options.activate) {
    writeCurrentReleasePointer({
      version,
      dbPath,
      manifestPath,
      activatedAt: new Date().toISOString(),
    })
  }

  maybeRecordAdminAction(
    options.activate ? 'release.build_and_activate' : 'release.build',
    version,
    options.actor,
  )

  return {
    version,
    dbPath,
    manifestPath,
    activated: options.activate === true,
  }
}

export function activateRelease(version: string, actor?: string | null): ReleaseActionResult {
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  if (!existsSync(dbPath)) {
    throw new Error(`Release DB not found: ${dbPath}`)
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Release manifest not found: ${manifestPath}`)
  }

  readReleaseManifest(manifestPath)
  writeCurrentReleasePointer({
    version,
    dbPath,
    manifestPath,
    activatedAt: new Date().toISOString(),
  })

  maybeRecordAdminAction('release.activate', version, actor)

  return {
    version,
    dbPath,
    manifestPath,
    activated: true,
  }
}

export function promoteRelease(options: PromoteReleaseOptions = {}): ReleaseActionResult {
  const activeRelease = requireActiveReleaseConfig()
  const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
  const updatesDb = initUpdatesDatabase()
  const shouldActivate = options.activate !== false

  const promotedFromUpdateSequence = getPromotedFromUpdateSequence(updatesDb)
  const snapshot = loadSnapshotFromReleaseDb(releaseDb)
  const mergedSnapshot = applyActiveUpdatesToSnapshot(snapshot, updatesDb)

  const version = options.version ?? buildReleaseVersion()
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

  assertReleaseVersionAvailable(version, dbPath, manifestPath)
  writeReleaseSnapshotToDb(dbPath, mergedSnapshot)
  writeReleaseManifest(version, {
    version,
    builtAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    baseSourceFingerprint: `promoted-from:${activeRelease.version}`,
    releaseDbPath: dbPath,
    promotedFromUpdateSequence,
  })

  if (shouldActivate) {
    markAllActiveUpdatesPromoted(updatesDb)
    writeCurrentReleasePointer({
      version,
      dbPath,
      manifestPath,
      activatedAt: new Date().toISOString(),
    })
  }

  releaseDb.close()
  updatesDb.close()

  maybeRecordAdminAction(
    shouldActivate ? 'release.promote_and_activate' : 'release.promote',
    version,
    options.actor,
  )

  return {
    version,
    dbPath,
    manifestPath,
    activated: shouldActivate,
  }
}

export function listReleases(): ReleaseListItem[] {
  const active = readCurrentReleasePointer()
  if (!existsSync(RELEASES_DIR)) return []

  const versions = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  return versions
    .map((version) => {
      const manifestPath = getReleaseManifestPath(version)
      const dbPath = getReleaseDbPath(version)
      if (!existsSync(manifestPath) || !existsSync(dbPath)) return null
      const manifest = readReleaseManifest(manifestPath)
      return {
        version,
        dbPath,
        manifestPath,
        builtAt: manifest.builtAt,
        schemaVersion: manifest.schemaVersion,
        baseSourceFingerprint: manifest.baseSourceFingerprint,
        promotedFromUpdateSequence: manifest.promotedFromUpdateSequence,
        isActive: active?.version === version,
      } satisfies ReleaseListItem
    })
    .filter((item): item is ReleaseListItem => item !== null)
}
