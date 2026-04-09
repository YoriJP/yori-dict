import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'fs'
import {
  type ReleaseSnapshot,
  buildReleaseVersion,
  computeFingerprintForFiles,
  getReleaseDbPath,
  getReleaseManifestPath,
  makeTranslationKey,
  readCurrentReleasePointer,
  readReleaseManifest,
  RELEASES_DIR,
  requireActiveReleaseConfig,
  writeCurrentReleasePointer,
  writeReleaseManifest,
} from './storage'
import { initUpdatesDatabase, markAllActiveUpdatesPromoted, recordAdminAction } from './update-store'
import { applyActiveUpdatesToSnapshot, loadSnapshotFromJson, loadSnapshotFromReleaseDb, writeReleaseSnapshotToDb } from '../scripts/release/lib'

const DATA_DIR = './data'
const CORE_PATH = `${DATA_DIR}/core.json`
const LANG_DIR = `${DATA_DIR}/lang`

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
  const files: string[] = []
  if (existsSync(CORE_PATH)) files.push(CORE_PATH)
  if (existsSync(LANG_DIR)) {
    for (const lang of ['en', 'de', 'ko', 'zh-cn', 'zh-tw']) {
      const path = `${LANG_DIR}/${lang}.json`
      if (existsSync(path)) files.push(path)
    }
  }
  return files
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

function cloneSnapshot(snapshot: ReleaseSnapshot): ReleaseSnapshot {
  return {
    words: new Map(
      [...snapshot.words.entries()].map(([wordId, record]) => [wordId, { ...record, partOfSpeech: [...record.partOfSpeech], jlpt: [...record.jlpt] }])
    ),
    translations: new Map(
      [...snapshot.translations.entries()].map(([key, record]) => [key, { ...record, definitions: [...record.definitions], sources: [...record.sources] }])
    ),
    examples: new Map(
      [...snapshot.examples.entries()].map(([key, records]) => [key, records.map((record) => ({ ...record }))])
    ),
  }
}

function overlayWordFromSnapshot(
  targetSnapshot: ReleaseSnapshot,
  sourceSnapshot: ReleaseSnapshot,
  wordId: string
): void {
  const sourceWord = sourceSnapshot.words.get(wordId)
  if (!sourceWord) return

  targetSnapshot.words.set(wordId, {
    ...sourceWord,
    partOfSpeech: [...sourceWord.partOfSpeech],
    jlpt: [...sourceWord.jlpt],
  })

  const sourceLangs = new Set<string>()
  for (const translation of sourceSnapshot.translations.values()) {
    if (translation.wordId !== wordId) continue
    sourceLangs.add(translation.lang)
    targetSnapshot.translations.set(makeTranslationKey(wordId, translation.lang), {
      ...translation,
      definitions: [...translation.definitions],
      sources: [...translation.sources],
    })
  }

  for (const examples of sourceSnapshot.examples.values()) {
    for (const example of examples) {
      if (example.wordId === wordId) sourceLangs.add(example.lang)
    }
  }

  for (const lang of sourceLangs) {
    const key = makeTranslationKey(wordId, lang)
    if (!sourceSnapshot.translations.has(key)) {
      targetSnapshot.translations.delete(key)
    }

    const sourceExamples = sourceSnapshot.examples.get(key) ?? []
    if (sourceExamples.length > 0) {
      targetSnapshot.examples.set(key, sourceExamples.map((example) => ({ ...example })))
    } else {
      targetSnapshot.examples.delete(key)
    }
  }
}

export async function buildRelease(options: BuildReleaseOptions = {}): Promise<ReleaseActionResult> {
  const snapshot = await loadSnapshotFromJson()
  const fingerprint = computeFingerprintForFiles(collectFingerprintFiles())
  const version = options.version ?? buildReleaseVersion(new Date(), fingerprint)
  const dbPath = getReleaseDbPath(version)
  const manifestPath = getReleaseManifestPath(version)

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

  const activeRelease = requireActiveReleaseConfig()
  const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
  const updatesDb = initUpdatesDatabase()

  try {
    const baseSnapshot = cloneSnapshot(loadSnapshotFromReleaseDb(releaseDb))
    overlayWordFromSnapshot(baseSnapshot, jsonSnapshot, wordId)
    const mergedSnapshot = applyActiveUpdatesToSnapshot(baseSnapshot, updatesDb)
    const fingerprint = computeFingerprintForFiles(collectFingerprintFiles())
    const version = options.version ?? buildReleaseVersion(new Date(), fingerprint)
    const dbPath = getReleaseDbPath(version)
    const manifestPath = getReleaseManifestPath(version)

    writeReleaseSnapshotToDb(dbPath, mergedSnapshot)
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
  } finally {
    releaseDb.close()
    updatesDb.close()
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

  const promotedFromUpdateSequence = getPromotedFromUpdateSequence(updatesDb)
  const snapshot = loadSnapshotFromReleaseDb(releaseDb)
  const mergedSnapshot = applyActiveUpdatesToSnapshot(snapshot, updatesDb)

  const version = options.version ?? buildReleaseVersion()
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

  if (options.activate !== false) {
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
    options.activate === false ? 'release.promote' : 'release.promote_and_activate',
    version,
    options.actor,
  )

  return {
    version,
    dbPath,
    manifestPath,
    activated: options.activate !== false,
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
