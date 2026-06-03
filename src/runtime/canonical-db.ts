import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import {
  CanonicalLookupService,
  type CanonicalEntryDetail,
  type CanonicalKanjiDetail,
  type CanonicalLookupInput,
  type CanonicalLookupResult,
} from './canonical-lookup'
import type { TargetLanguage } from '../domain/types'

export const CANONICAL_RELEASE_DB_PATH_ENV = 'CANONICAL_RELEASE_DB_PATH'

export class CanonicalLookupUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalLookupUnavailableError'
  }
}

let canonicalDb: Database | null = null
let canonicalDbPath: string | null = null
let canonicalLookupService: CanonicalLookupService | null = null

function getCanonicalReleaseDbPath(): string {
  const path = process.env[CANONICAL_RELEASE_DB_PATH_ENV]?.trim()
  if (!path) {
    throw new CanonicalLookupUnavailableError(`${CANONICAL_RELEASE_DB_PATH_ENV} is not configured`)
  }
  if (!existsSync(path)) {
    throw new CanonicalLookupUnavailableError(`Canonical release DB not found: ${path}`)
  }
  return path
}

export function getCanonicalLookupService(): CanonicalLookupService {
  const path = getCanonicalReleaseDbPath()
  if (canonicalLookupService && canonicalDbPath === path) return canonicalLookupService

  closeCanonicalDb()
  canonicalDb = new Database(path, { readonly: true })
  canonicalDbPath = path
  canonicalLookupService = new CanonicalLookupService(canonicalDb)
  return canonicalLookupService
}

export function lookupCanonical(input: CanonicalLookupInput): CanonicalLookupResult {
  return getCanonicalLookupService().lookup(input)
}

export function getCanonicalEntry(id: string, lang?: TargetLanguage): CanonicalEntryDetail | null {
  return getCanonicalLookupService().getEntry(id, lang)
}

export function getCanonicalKanji(literal: string, lang?: TargetLanguage): CanonicalKanjiDetail | null {
  return getCanonicalLookupService().getKanji(literal, lang)
}

export function closeCanonicalDb(): void {
  if (canonicalDb) {
    canonicalDb.close()
  }
  canonicalDb = null
  canonicalDbPath = null
  canonicalLookupService = null
}
