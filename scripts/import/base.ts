/**
 * Base types and merge logic for dictionary imports
 */

import { existsSync, renameSync, unlinkSync } from 'fs'

// ============================================================================
// Types
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

export interface DictEntry {
  word: string
  reading: string
  partOfSpeech: string[]
  common: boolean
  jlpt: number[]
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

export type ImportMode = 'merge' | 'diff' | 'replace'

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
 * Merge JLPT levels - keep all unique levels, sorted descending (N5=5 first)
 */
export function mergeJlpt(levels1: number[], levels2: number[]): number[] {
  const merged = mergeArrays(levels1, levels2)
  return merged.sort((a, b) => b - a) // Sort descending: [5, 4, 3, 2, 1]
}

/**
 * Normalize definition text for comparison
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().trim()
}

/**
 * Merge definitions - same text gets sources merged
 */
export function mergeDefinitions(defs1: Definition[], defs2: Definition[]): Definition[] {
  const defMap = new Map<string, Definition>()

  // Add all from defs1
  for (const def of defs1) {
    const normalized = normalizeText(def.text)
    defMap.set(normalized, {
      text: def.text,
      sources: [...def.sources],
    })
  }

  // Merge from defs2
  for (const def of defs2) {
    const normalized = normalizeText(def.text)
    const existing = defMap.get(normalized)

    if (existing) {
      // Same text - merge sources
      existing.sources = mergeArrays(existing.sources, def.sources)
    } else {
      // New definition
      defMap.set(normalized, {
        text: def.text,
        sources: [...def.sources],
      })
    }
  }

  return Array.from(defMap.values())
}

/**
 * Merge examples - dedupe by Japanese text + translation
 */
export function mergeExamples(ex1: Example[], ex2: Example[]): Example[] {
  const exMap = new Map<string, Example>()
  const makeExampleKey = (ex: Example) => `${ex.ja}\u0000${ex.text}`

  for (const ex of ex1) {
    exMap.set(makeExampleKey(ex), {
      ...ex,
      sources: [...ex.sources],
    })
  }

  for (const ex of ex2) {
    const key = makeExampleKey(ex)
    const existing = exMap.get(key)
    if (!existing) {
      exMap.set(key, {
        ...ex,
        sources: [...ex.sources],
      })
      continue
    }
    existing.sources = mergeArrays(existing.sources, ex.sources)
  }

  return Array.from(exMap.values())
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
export function mergeEntries(entry1: DictEntry, entry2: DictEntry): DictEntry {
  return {
    word: entry1.word,
    reading: entry1.reading,
    partOfSpeech: mergeArrays(entry1.partOfSpeech, entry2.partOfSpeech),
    common: entry1.common || entry2.common,
    jlpt: mergeJlpt(entry1.jlpt, entry2.jlpt),
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
    }
    return dict
  }

  return createEmptyDict(lang)
}

/**
 * Save dictionary file with updated stats
 */
export async function saveDict(path: string, dict: DictFile): Promise<void> {
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
