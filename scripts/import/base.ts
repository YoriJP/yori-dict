/**
 * Base types and merge logic for dictionary imports
 */

import { existsSync, renameSync, unlinkSync } from 'fs'

// ============================================================================
// New Schema Types (v2.0.0)
// ============================================================================

export interface CoreEntry {
  word: string
  reading: string
  partOfSpeech: string[]    // clean strings, no sources
  common: boolean
  jlpt: number | null       // highest JLPT level (e.g. 5 for N5) or null
  frequency: number | null  // JPDB rank (lower = more common) or null
}

export interface CoreFile {
  version: string           // "2.0.0"
  updatedAt: string
  stats: { entries: number }
  entries: Record<string, CoreEntry>
}

export interface LangEntry {
  definitions: string[]
  examples: { ja: string; text: string; source: string }[]
  _defSources: Record<string, string[]>  // def text → source names
}

export interface LangFile {
  version: string           // "2.0.0"
  lang: string
  updatedAt: string
  stats: {
    entries: number
    withExamples: number
    sources: Record<string, number>
  }
  entries: Record<string, LangEntry>
}

export type DuplicateConflictPolicy = 'merge' | 'skip' | 'replace'
export type DuplicateConflictPolicyInput = DuplicateConflictPolicy | 'ask'

export interface DuplicateConflictSample {
  key: string
  existingDefinitions: string[]
  incomingDefinitions: string[]
  overlaps: Array<{ existing: string; incoming: string }>
}

export interface DuplicateConflictAnalysis {
  conflictCount: number
  samples: DuplicateConflictSample[]
}

// ============================================================================
// Core I/O
// ============================================================================

export function createEmptyCore(): CoreFile {
  return {
    version: '2.0.0',
    updatedAt: new Date().toISOString(),
    stats: { entries: 0 },
    entries: {},
  }
}

export async function loadCore(path: string): Promise<CoreFile> {
  const file = Bun.file(path)
  if (await file.exists()) {
    return file.json() as Promise<CoreFile>
  }
  return createEmptyCore()
}

export async function saveCore(path: string, core: CoreFile): Promise<void> {
  core.stats.entries = Object.keys(core.entries).length
  core.updatedAt = new Date().toISOString()
  await Bun.write(path, JSON.stringify(core))
}

// ============================================================================
// Lang I/O
// ============================================================================

export function createEmptyLang(lang: string): LangFile {
  return {
    version: '2.0.0',
    lang,
    updatedAt: new Date().toISOString(),
    stats: { entries: 0, withExamples: 0, sources: {} },
    entries: {},
  }
}

export function createEmptyLangEntry(): LangEntry {
  return { definitions: [], examples: [], _defSources: {} }
}

export async function loadLang(path: string, lang: string): Promise<LangFile> {
  const file = Bun.file(path)
  if (await file.exists()) {
    const data = await file.json() as LangFile
    // Normalize: ensure _defSources exists on every entry
    for (const entry of Object.values(data.entries)) {
      if (!entry._defSources) entry._defSources = {}
      if (!entry.examples) entry.examples = []
      if (!entry.definitions) entry.definitions = []
    }
    return data
  }
  return createEmptyLang(lang)
}

export async function saveLang(path: string, lang: LangFile): Promise<void> {
  const entries = Object.values(lang.entries)
  lang.stats.entries = entries.length
  lang.stats.withExamples = entries.filter((e) => e.examples.length > 0).length

  // Count sources from _defSources
  const sourceCounts: Record<string, number> = {}
  for (const entry of entries) {
    for (const sources of Object.values(entry._defSources)) {
      for (const source of sources) {
        sourceCounts[source] = (sourceCounts[source] || 0) + 1
      }
    }
  }
  lang.stats.sources = sourceCounts
  lang.updatedAt = new Date().toISOString()
  await Bun.write(path, JSON.stringify(lang))
}

// ============================================================================
// Lang Entry Helpers
// ============================================================================

/**
 * Add a definition to a LangEntry, deduplicating by case-insensitive text.
 * If the definition already exists, the source is added to _defSources.
 */
export function addLangDefinition(entry: LangEntry, text: string, source: string): void {
  const sanitized = sanitizeDefinitionText(text)
  if (isDefinitionArtifact(sanitized)) return

  const normalized = sanitized.toLowerCase().trim()

  // Find existing definition with matching normalized text
  const existingDef = entry.definitions.find((d) => d.toLowerCase().trim() === normalized)

  if (existingDef !== undefined) {
    // Update sources for existing definition
    const sources = entry._defSources[existingDef] ?? []
    if (!sources.includes(source)) {
      entry._defSources[existingDef] = [...sources, source]
    }
  } else {
    // Add new definition
    entry.definitions.push(sanitized)
    entry._defSources[sanitized] = [source]
  }
}

function normalizeDefinitionForConflict(text: string): string {
  return sanitizeDefinitionText(text).toLowerCase().trim()
}

export function isLikelyDefinitionConflict(existingDef: string, incomingDef: string): boolean {
  const existing = normalizeDefinitionForConflict(existingDef)
  const incoming = normalizeDefinitionForConflict(incomingDef)
  if (!existing || !incoming) return false
  if (existing === incoming) return true

  // Lightweight similarity check for near-duplicates like:
  // "to eat" vs "to eat food", while avoiding very short noisy matches.
  if (existing.length >= 6 && incoming.length >= 6) {
    return existing.includes(incoming) || incoming.includes(existing)
  }
  return false
}

function collectDefinitionOverlaps(
  existingDefinitions: string[],
  incomingDefinitions: string[]
): Array<{ existing: string; incoming: string }> {
  const overlaps: Array<{ existing: string; incoming: string }> = []

  for (const incoming of incomingDefinitions) {
    const matched = existingDefinitions.find((existing) => isLikelyDefinitionConflict(existing, incoming))
    if (matched) {
      overlaps.push({ existing: matched, incoming })
    }
  }

  return overlaps
}

function cloneLangEntry(entry: LangEntry): LangEntry {
  const clonedSources: Record<string, string[]> = {}
  for (const [def, sources] of Object.entries(entry._defSources)) {
    clonedSources[def] = [...sources]
  }
  return {
    definitions: [...entry.definitions],
    examples: entry.examples.map((ex) => ({ ...ex })),
    _defSources: clonedSources,
  }
}

function addLangExamples(
  entry: LangEntry,
  examples: { ja: string; text: string; source: string }[]
): void {
  for (const ex of examples) {
    const exists = entry.examples.some(
      (e) => e.ja === ex.ja && e.text === ex.text && e.source === ex.source
    )
    if (!exists) entry.examples.push(ex)
  }
}

function removeLangDefinition(entry: LangEntry, definition: string): void {
  entry.definitions = entry.definitions.filter((def) => def !== definition)
  delete entry._defSources[definition]
}

function applyIncomingLangData(
  entry: LangEntry,
  srcEntry: { definitions: string[]; examples?: { ja: string; text: string; source: string }[] },
  sourceName: string
): void {
  for (const def of srcEntry.definitions) {
    addLangDefinition(entry, def, sourceName)
  }
  addLangExamples(entry, srcEntry.examples ?? [])
}

export function analyzeLangDefinitionConflicts(
  target: Record<string, LangEntry>,
  source: Record<string, { definitions: string[]; examples?: { ja: string; text: string; source: string }[] }>,
  sampleSize: number
): DuplicateConflictAnalysis {
  let conflictCount = 0
  const samples: DuplicateConflictSample[] = []

  for (const [key, srcEntry] of Object.entries(source)) {
    const existing = target[key]
    if (!existing) continue

    const overlaps = collectDefinitionOverlaps(existing.definitions, srcEntry.definitions)
    if (overlaps.length === 0) continue
    conflictCount++

    if (samples.length < sampleSize) {
      samples.push({
        key,
        existingDefinitions: existing.definitions.slice(0, 5),
        incomingDefinitions: srcEntry.definitions.slice(0, 5),
        overlaps: overlaps.slice(0, 3),
      })
    }
  }

  return { conflictCount, samples }
}

export async function resolveDuplicateConflictPolicy(
  sourceName: string,
  requestedPolicy: DuplicateConflictPolicyInput,
  analysis: DuplicateConflictAnalysis
): Promise<DuplicateConflictPolicy> {
  if (requestedPolicy !== 'ask') return requestedPolicy

  if (analysis.conflictCount === 0) {
    console.log(`\n[${sourceName}] No duplicate/similar definition conflicts found. Using merge.`)
    return 'merge'
  }

  console.log(`\n[${sourceName}] Duplicate/similar definition conflicts found: ${analysis.conflictCount.toLocaleString()}`)
  if (analysis.samples.length > 0) {
    console.log(`[${sourceName}] Sample conflicts:`)
    for (const sample of analysis.samples) {
      console.log(`  - ${sample.key}`)
      for (const overlap of sample.overlaps) {
        console.log(`      existing: "${overlap.existing}"`)
        console.log(`      incoming: "${overlap.incoming}"`)
      }
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn(`[${sourceName}] Non-interactive terminal detected. Falling back to merge.`)
    return 'merge'
  }

  const { createInterface } = await import('readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    while (true) {
      const answer = (await rl.question(
        `[${sourceName}] Choose policy for incoming conflicting definitions [skip/replace/merge]: `
      ))
        .trim()
        .toLowerCase()

      if (answer === 'skip' || answer === 's') return 'skip'
      if (answer === 'replace' || answer === 'r') return 'replace'
      if (answer === 'merge' || answer === 'm') return 'merge'

      console.log('Please type one of: skip, replace, merge')
    }
  } finally {
    rl.close()
  }
}

/**
 * Remove all definitions where sourceName is the only source.
 * Also removes sourceName from _defSources of remaining definitions.
 */
export function refreshLangSource(
  target: Record<string, LangEntry>,
  sourceName: string
): void {
  for (const [key, entry] of Object.entries(target)) {
    // Find definitions that only have this source
    const toRemove = new Set(
      entry.definitions.filter((def) => {
        const sources = entry._defSources[def] ?? []
        return sources.includes(sourceName) && sources.length === 1
      })
    )

    // Remove those definitions
    entry.definitions = entry.definitions.filter((d) => !toRemove.has(d))

    // Remove removed defs from _defSources
    for (const def of toRemove) {
      delete entry._defSources[def]
    }

    // Strip sourceName from remaining defs' _defSources
    for (const def of entry.definitions) {
      const sources = entry._defSources[def]
      if (sources) {
        const updated = sources.filter((s) => s !== sourceName)
        if (updated.length > 0) {
          entry._defSources[def] = updated
        } else {
          delete entry._defSources[def]
        }
      }
    }

    // Strip sourceName from examples
    entry.examples = entry.examples.filter((ex) => ex.source !== sourceName)

    // Remove stale _defSources keys that no longer have a matching definition
    const defSet = new Set(entry.definitions)
    for (const def of Object.keys(entry._defSources)) {
      if (!defSet.has(def)) delete entry._defSources[def]
    }

    // Prune empty entries after source refresh
    if (entry.definitions.length === 0 && entry.examples.length === 0) {
      delete target[key]
    }
  }
}

// ============================================================================
// Core Merge
// ============================================================================

/**
 * Merge source CoreEntry records into target.
 */
export function mergeCoreEntries(
  target: Record<string, CoreEntry>,
  source: Record<string, CoreEntry>,
  mode: ImportMode
): { added: number; updated: number; unchanged: number } {
  let added = 0
  let updated = 0
  let unchanged = 0

  if (mode === 'replace') {
    // Prune stale entries not in source
    for (const key of Object.keys(target)) {
      if (!source[key]) delete target[key]
    }
    // Overwrite all source entries
    for (const [key, srcEntry] of Object.entries(source)) {
      if (target[key]) updated++
      else added++
      target[key] = srcEntry
    }
    return { added, updated, unchanged }
  }

  for (const [key, srcEntry] of Object.entries(source)) {
    const existing = target[key]
    if (!existing) {
      if (mode !== 'diff') target[key] = { ...srcEntry }
      added++
    } else {
      // Merge POS (union)
      const posSet = new Set([...existing.partOfSpeech, ...srcEntry.partOfSpeech])
      // Keep best jlpt (highest number = easiest level)
      let jlpt: number | null = existing.jlpt
      if (srcEntry.jlpt !== null) {
        jlpt = jlpt === null ? srcEntry.jlpt : Math.max(jlpt, srcEntry.jlpt)
      }
      // Keep best frequency (lowest rank = more common)
      let frequency: number | null = existing.frequency
      if (srcEntry.frequency !== null) {
        frequency = frequency === null ? srcEntry.frequency : Math.min(frequency, srcEntry.frequency)
      }
      const common = existing.common || srcEntry.common

      const changed =
        JSON.stringify([...posSet]) !== JSON.stringify(existing.partOfSpeech) ||
        jlpt !== existing.jlpt ||
        frequency !== existing.frequency ||
        common !== existing.common

      if (changed) {
        if (mode !== 'diff') {
          existing.partOfSpeech = Array.from(posSet)
          existing.jlpt = jlpt
          existing.frequency = frequency
          existing.common = common
        }
        updated++
      } else {
        unchanged++
      }
    }
  }

  return { added, updated, unchanged }
}

// ============================================================================
// Lang Merge
// ============================================================================

/**
 * Merge source lang entries into target LangFile entries.
 * source is a map of key → { definitions: string[]; examples?: ... }
 */
export function mergeLangEntries(
  target: Record<string, LangEntry>,
  source: Record<string, { definitions: string[]; examples?: { ja: string; text: string; source: string }[] }>,
  sourceName: string,
  mode: ImportMode,
  conflictPolicy: DuplicateConflictPolicy = 'merge'
): { added: number; updated: number; unchanged: number } {
  let added = 0
  let updated = 0
  let unchanged = 0

  if (mode === 'replace') {
    // Prune stale entries not in source
    for (const key of Object.keys(target)) {
      if (!source[key]) delete target[key]
    }
    // Overwrite all source entries
    for (const [key, srcEntry] of Object.entries(source)) {
      const langEntry = createEmptyLangEntry()
      for (const def of srcEntry.definitions) {
        addLangDefinition(langEntry, def, sourceName)
      }
      for (const ex of srcEntry.examples ?? []) {
        langEntry.examples.push(ex)
      }
      if (target[key]) updated++
      else added++
      target[key] = langEntry
    }
    return { added, updated, unchanged }
  }

  for (const [key, srcEntry] of Object.entries(source)) {
    if (!target[key]) {
      if (mode !== 'diff') {
        const langEntry = createEmptyLangEntry()
        applyIncomingLangData(langEntry, srcEntry, sourceName)
        target[key] = langEntry
      }
      added++
    } else {
      const overlaps = collectDefinitionOverlaps(
        target[key].definitions,
        srcEntry.definitions
      )
      const hasDefinitionConflict = overlaps.length > 0

      if (hasDefinitionConflict && conflictPolicy === 'skip') {
        unchanged++
        continue
      }

      if (hasDefinitionConflict && conflictPolicy === 'replace') {
        const before = JSON.stringify(target[key])
        const replacement = cloneLangEntry(target[key])
        for (const existingDef of new Set(overlaps.map((ov) => ov.existing))) {
          removeLangDefinition(replacement, existingDef)
        }
        applyIncomingLangData(replacement, srcEntry, sourceName)

        const changed = JSON.stringify(replacement) !== before
        if (changed) {
          if (mode !== 'diff') {
            target[key] = replacement
          }
          updated++
        } else {
          unchanged++
        }
        continue
      }

      const before = JSON.stringify(target[key])
      const nextEntry = mode === 'diff' ? cloneLangEntry(target[key]) : target[key]
      applyIncomingLangData(nextEntry, srcEntry, sourceName)

      if (mode !== 'diff') {
        target[key] = nextEntry
      }

      if (JSON.stringify(nextEntry) !== before) updated++
      else unchanged++
    }
  }

  return { added, updated, unchanged }
}

// ============================================================================
// Types (legacy v1.0.0 schema — kept for backward compatibility)
// ============================================================================

export interface Definition {
  text: string
  sources: string[]
}

export interface Example {
  ja: string
  text: string
  sources: string[]
}

export interface PosEntry {
  value: string
  sources: string[]
}

export interface JlptEntry {
  level: number
  sources: string[]
}

export interface FrequencyEntry {
  rank: number
  sources: string[]
}

export interface DictEntry {
  word: string
  reading: string
  partOfSpeech: PosEntry[]
  common: boolean
  commonSources: string[]
  jlpt: JlptEntry[]
  frequency?: FrequencyEntry
  definitions: Definition[]
  examples: Example[]
}

export interface DictFile {
  version: string
  lang: string
  updatedAt: string
  stats: {
    entries: number
    withExamples: number
    sources: Record<string, number>
  }
  entries: Record<string, DictEntry>
}

export type ImportMode = 'merge' | 'diff' | 'replace' | 'refresh'

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generate unique key from word and reading
 */
export function makeKey(word: string, reading: string): string {
  return `${word}:${reading}`
}

/**
 * Parse key back to word and reading
 */
export function parseKey(key: string): { word: string; reading: string } {
  const [word, reading] = key.split(':')
  return { word, reading }
}

// ============================================================================
// Merge Logic
// ============================================================================

/**
 * Merge two string arrays, keeping unique values
 */
export function mergeArrays<T>(arr1: T[], arr2: T[]): T[] {
  const set = new Set([...arr1, ...arr2])
  return Array.from(set)
}

/**
 * Merge PosEntry arrays - same value gets sources unioned
 */
export function mergePartOfSpeech(pos1: PosEntry[], pos2: PosEntry[]): PosEntry[] {
  const map = new Map<string, PosEntry>()
  for (const p of pos1) {
    map.set(p.value, { value: p.value, sources: [...p.sources] })
  }
  for (const p of pos2) {
    const existing = map.get(p.value)
    if (existing) {
      existing.sources = mergeArrays(existing.sources, p.sources)
    } else {
      map.set(p.value, { value: p.value, sources: [...p.sources] })
    }
  }
  return Array.from(map.values())
}

/**
 * Merge JlptEntry arrays - same level gets sources unioned, sorted descending (N5=5 first)
 */
export function mergeJlptEntries(jlpt1: JlptEntry[], jlpt2: JlptEntry[]): JlptEntry[] {
  const map = new Map<number, JlptEntry>()
  for (const j of jlpt1) {
    map.set(j.level, { level: j.level, sources: [...j.sources] })
  }
  for (const j of jlpt2) {
    const existing = map.get(j.level)
    if (existing) {
      existing.sources = mergeArrays(existing.sources, j.sources)
    } else {
      map.set(j.level, { level: j.level, sources: [...j.sources] })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.level - a.level)
}

/**
 * Normalize definition text for comparison
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().trim()
}

const INLINE_TAG_PATTERN = /<[^>]*:\s*([^<>]*)>/g
const MARKER_TAG_PATTERN = /<[^>]+>/g
const BARE_HW_FRAGMENT_PATTERN = /(^|[\s(])\{?\s*HW\s+[a-z]{1,4}\s*:\s*/gi
const RESIDUAL_HW_PATTERN = /(^|[\s(])\{?\s*HW\s+[a-z]{1,4}\s*:/i

/**
 * Best-effort cleanup for malformed upstream markup fragments in definition text.
 */
export function sanitizeDefinitionText(text: string): string {
  let cleaned = String(text ?? '').replace(/\u00A0/g, ' ').trim()
  let prev = ''

  // Repeatedly unwrap nested angle-bracket tags (Wadoku-style markup)
  // until no more changes occur.
  while (prev !== cleaned) {
    prev = cleaned
    cleaned = cleaned.replace(INLINE_TAG_PATTERN, '$1')
    cleaned = cleaned.replace(MARKER_TAG_PATTERN, ' ')
  }

  cleaned = cleaned
    // Handle malformed bare HW fragments like "HW n: Verlassen" or "{HW n:".
    .replace(BARE_HW_FRAGMENT_PATTERN, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned
}

/**
 * Detects residual import artifacts that should not be shipped to clients.
 */
export function isDefinitionArtifact(text: string): boolean {
  const cleaned = text.trim()
  if (cleaned.length === 0) return true
  if (cleaned.includes('<') || cleaned.includes('>')) return true
  if (RESIDUAL_HW_PATTERN.test(cleaned)) return true
  return false
}

/**
 * Merge definitions - same text gets sources merged only when sources overlap.
 * Definitions with the same text but disjoint sources are kept separate.
 */
export function mergeDefinitions(defs1: Definition[], defs2: Definition[]): Definition[] {
  const result: Definition[] = []

  const findMatchingDef = (normalized: string, sources: string[]): Definition | undefined => {
    return result.find(
      (d) => normalizeText(d.text) === normalized && d.sources.some((s) => sources.includes(s))
    )
  }

  const upsert = (def: Definition): void => {
    const text = sanitizeDefinitionText(def.text)
    if (isDefinitionArtifact(text)) return

    const normalized = normalizeText(text)
    const existing = findMatchingDef(normalized, def.sources)

    if (existing) {
      existing.sources = mergeArrays(existing.sources, def.sources)
    } else {
      result.push({ text, sources: mergeArrays([], def.sources) })
    }
  }

  for (const def of defs1) upsert(def)
  for (const def of defs2) upsert(def)

  return result
}

/**
 * Re-import a single source's data into the target dictionary.
 * Strips all existing data attributed to sourceName, then merges the new source data.
 */
export function refreshDictSource(
  target: Record<string, DictEntry>,
  source: Record<string, DictEntry>,
  sourceName: string
): { added: number; updated: number; removed: number } {
  let added = 0
  let updated = 0
  let removed = 0

  // Step 1: Strip all data attributed to sourceName from every field
  for (const entry of Object.values(target)) {
    entry.definitions = entry.definitions.filter((d) => !d.sources.includes(sourceName))
    entry.examples = entry.examples.filter((e) => !e.sources.includes(sourceName))
    entry.partOfSpeech = entry.partOfSpeech
      .map((p) => ({ ...p, sources: p.sources.filter((s) => s !== sourceName) }))
      .filter((p) => p.sources.length > 0)
    entry.jlpt = entry.jlpt
      .map((j) => ({ ...j, sources: j.sources.filter((s) => s !== sourceName) }))
      .filter((j) => j.sources.length > 0)
    entry.commonSources = entry.commonSources.filter((s) => s !== sourceName)
    entry.common = entry.commonSources.length > 0
    if (entry.frequency?.sources.includes(sourceName)) {
      const remaining = entry.frequency.sources.filter((s) => s !== sourceName)
      entry.frequency = remaining.length > 0 ? { rank: entry.frequency.rank, sources: remaining } : undefined
    }
  }

  // Step 2: Remove entries that are now empty and not in source
  const isEmpty = (e: DictEntry) =>
    e.definitions.length === 0 && e.examples.length === 0 &&
    e.partOfSpeech.length === 0 && e.jlpt.length === 0 && e.commonSources.length === 0

  const sourceKeys = new Set(Object.keys(source))
  for (const key of Object.keys(target)) {
    const entry = target[key]
    if (isEmpty(entry) && !sourceKeys.has(key)) {
      delete target[key]
      removed++
    }
  }

  // Step 3: Merge source entries into target
  for (const [key, sourceEntry] of Object.entries(source)) {
    if (!target[key]) {
      target[key] = sourceEntry
      added++
    } else {
      const before = JSON.stringify(target[key])
      target[key] = mergeEntries(target[key], sourceEntry)
      if (JSON.stringify(target[key]) !== before) {
        updated++
      }
    }
  }

  return { added, updated, removed }
}

/**
 * Merge examples - same ja+text with overlapping sources get merged;
 * same ja+text with disjoint sources stay separate (source isolation).
 */
export function mergeExamples(ex1: Example[], ex2: Example[]): Example[] {
  const result: Example[] = []
  const makeExKey = (ex: Example) => `${ex.ja}\u0000${ex.text}`

  const findMatch = (key: string, sources: string[]): Example | undefined =>
    result.find((e) => makeExKey(e) === key && e.sources.some((s) => sources.includes(s)))

  const upsert = (ex: Example) => {
    const key = makeExKey(ex)
    const existing = findMatch(key, ex.sources)
    if (existing) {
      existing.sources = mergeArrays(existing.sources, ex.sources)
    } else {
      result.push({ ...ex, sources: [...ex.sources] })
    }
  }

  for (const ex of ex1) upsert(ex)
  for (const ex of ex2) upsert(ex)
  return result
}

type RawExample = {
  ja?: unknown
  text?: unknown
  sources?: unknown
  source?: unknown
}

function parseSources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (source): source is string => typeof source === 'string' && source.length > 0
    )
  }
  return []
}

function normalizeExampleSources(ex: RawExample): Example {
  const parsedSources = parseSources(ex.sources)
  const sources = parsedSources.length > 0
    ? parsedSources
    : (typeof ex.source === 'string' && ex.source.length > 0 ? [ex.source] : [])

  return {
    ja: String(ex.ja ?? ''),
    text: String(ex.text ?? ''),
    sources: mergeArrays([], sources),
  }
}

/**
 * Merge two dictionary entries
 */
export function mergeFrequency(
  f1: FrequencyEntry | undefined,
  f2: FrequencyEntry | undefined
): FrequencyEntry | undefined {
  if (!f1 && !f2) return undefined
  if (!f1) return f2
  if (!f2) return f1
  // Keep the lower rank (higher frequency) and merge sources
  const rank = Math.min(f1.rank, f2.rank)
  return { rank, sources: mergeArrays(f1.sources, f2.sources) }
}

export function mergeEntries(entry1: DictEntry, entry2: DictEntry): DictEntry {
  return {
    word: entry1.word,
    reading: entry1.reading,
    partOfSpeech: mergePartOfSpeech(entry1.partOfSpeech, entry2.partOfSpeech),
    common: entry1.common || entry2.common,
    commonSources: mergeArrays(entry1.commonSources, entry2.commonSources),
    jlpt: mergeJlptEntries(entry1.jlpt, entry2.jlpt),
    frequency: mergeFrequency(entry1.frequency, entry2.frequency),
    definitions: mergeDefinitions(entry1.definitions, entry2.definitions),
    examples: mergeExamples(entry1.examples, entry2.examples),
  }
}

/**
 * Merge entries from source into target dictionary
 */
export function mergeDictEntries(
  target: Record<string, DictEntry>,
  source: Record<string, DictEntry>,
  mode: ImportMode
): { added: number; updated: number; unchanged: number } {
  let added = 0
  let updated = 0
  let unchanged = 0

  if (mode === 'replace') {
    const sourceKeys = new Set(Object.keys(source))

    // Prune stale entries not present in the source snapshot.
    for (const key of Object.keys(target)) {
      if (!sourceKeys.has(key)) {
        delete target[key]
      }
    }

    // Overwrite or add all source entries.
    for (const [key, sourceEntry] of Object.entries(source)) {
      if (target[key]) {
        updated++
      } else {
        added++
      }
      target[key] = sourceEntry
    }

    return { added, updated, unchanged }
  }

  for (const [key, sourceEntry] of Object.entries(source)) {
    const targetEntry = target[key]

    if (!targetEntry) {
      // New entry
      if (mode !== 'diff') {
        target[key] = sourceEntry
      }
      added++
    } else if (mode === 'merge' || mode === 'diff') {
      // Merge/diff mode - combine data and check for changes
      const merged = mergeEntries(targetEntry, sourceEntry)

      // Check if anything changed
      const changed =
        JSON.stringify(merged.definitions) !== JSON.stringify(targetEntry.definitions) ||
        JSON.stringify(merged.partOfSpeech) !== JSON.stringify(targetEntry.partOfSpeech) ||
        JSON.stringify(merged.jlpt) !== JSON.stringify(targetEntry.jlpt) ||
        merged.common !== targetEntry.common ||
        JSON.stringify(merged.commonSources) !== JSON.stringify(targetEntry.commonSources) ||
        JSON.stringify(merged.examples) !== JSON.stringify(targetEntry.examples)

      if (changed) {
        // Only mutate target in merge mode, not diff mode
        if (mode === 'merge') {
          target[key] = merged
        }
        updated++
      } else {
        unchanged++
      }
    }
  }

  return { added, updated, unchanged }
}

// ============================================================================
// Download Helpers
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Download a file with progress reporting. Skips if the file already exists.
 */
export async function downloadWithProgress(url: string, destPath: string): Promise<void> {
  if (existsSync(destPath)) {
    console.log(`  Cached: ${destPath}`)
    return
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'yori-dict-importer' },
  })

  if (!response.ok) {
    throw new Error(`Failed download (${response.status}): ${url}`)
  }

  const totalBytes = Number(response.headers.get('content-length') || 0)
  const totalStr = totalBytes ? formatBytes(totalBytes) : '?'

  if (!response.body) {
    throw new Error(`Empty response body: ${url}`)
  }

  const tmpPath = destPath + '.tmp'
  const file = Bun.file(tmpPath)
  const writer = file.writer()
  let received = 0
  let lastLog = 0

  try {
    for await (const chunk of response.body) {
      writer.write(chunk)
      received += chunk.byteLength

      if (totalBytes && received - lastLog > totalBytes * 0.05) {
        const pct = Math.round((received / totalBytes) * 100)
        process.stdout.write(`\r  Downloading: ${formatBytes(received)} / ${totalStr} (${pct}%)`)
        lastLog = received
      }
    }

    await writer.end()
    renameSync(tmpPath, destPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }

  process.stdout.write(`\r  Downloaded: ${formatBytes(received)} / ${totalStr} (100%)\n`)
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Create empty dictionary file
 */
export function createEmptyDict(lang: string): DictFile {
  return {
    version: '1.0.0',
    lang,
    updatedAt: new Date().toISOString(),
    stats: {
      entries: 0,
      withExamples: 0,
      sources: {},
    },
    entries: {},
  }
}

/**
 * Load dictionary file or create empty one
 */
export async function loadDict(path: string, lang: string): Promise<DictFile> {
  const file = Bun.file(path)

  if (await file.exists()) {
    const dict = await file.json() as DictFile
    for (const entry of Object.values(dict.entries)) {
      entry.examples = (entry.examples ?? []).map((ex) => normalizeExampleSources(ex))

      // Shim: string[] → PosEntry[]
      if (entry.partOfSpeech.length > 0 && typeof (entry.partOfSpeech as unknown[])[0] === 'string') {
        entry.partOfSpeech = (entry.partOfSpeech as unknown as string[])
          .map((value) => ({ value, sources: [] }))
      }
      // Shim: number[] → JlptEntry[]
      if (entry.jlpt.length > 0 && typeof (entry.jlpt as unknown[])[0] === 'number') {
        entry.jlpt = (entry.jlpt as unknown as number[])
          .map((level) => ({ level, sources: [] }))
      }
      // Shim: default missing commonSources
      if (!entry.commonSources) entry.commonSources = []
    }
    return dict
  }

  return createEmptyDict(lang)
}

/**
 * Save dictionary file with updated stats
 */
export async function saveDict(path: string, dict: DictFile): Promise<void> {
  for (const entry of Object.values(dict.entries)) {
    // Final guard to prevent malformed definition artifacts from being persisted.
    entry.definitions = mergeDefinitions([], entry.definitions)
  }

  // Update stats
  const entries = Object.values(dict.entries)
  dict.stats.entries = entries.length
  dict.stats.withExamples = entries.filter((e) => e.examples.length > 0).length

  // Count sources
  const sourceCounts: Record<string, number> = {}
  for (const entry of entries) {
    for (const def of entry.definitions) {
      for (const source of def.sources) {
        sourceCounts[source] = (sourceCounts[source] || 0) + 1
      }
    }
  }
  dict.stats.sources = sourceCounts

  // Update timestamp
  dict.updatedAt = new Date().toISOString()

  // Write file
  await Bun.write(path, JSON.stringify(dict))
}

/**
 * Print import statistics
 */
export function printStats(
  stats: { added: number; updated: number; unchanged: number },
  mode: ImportMode
): void {
  console.log('\n=== Import Statistics ===')
  console.log(`  New entries: ${stats.added.toLocaleString()}`)
  console.log(`  Updated entries: ${stats.updated.toLocaleString()}`)
  console.log(`  Unchanged entries: ${stats.unchanged.toLocaleString()}`)

  if (mode === 'diff') {
    console.log('\n  (Diff mode - no changes made)')
  }
}
