/**
 * Base types and merge logic for dictionary imports
 */

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
  source: string
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
 * Merge examples - dedupe by Japanese text
 */
export function mergeExamples(ex1: Example[], ex2: Example[]): Example[] {
  const exMap = new Map<string, Example>()

  for (const ex of ex1) {
    exMap.set(ex.ja, ex)
  }

  for (const ex of ex2) {
    if (!exMap.has(ex.ja)) {
      exMap.set(ex.ja, ex)
    }
  }

  return Array.from(exMap.values())
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

  for (const [key, sourceEntry] of Object.entries(source)) {
    const targetEntry = target[key]

    if (!targetEntry) {
      // New entry
      if (mode !== 'diff') {
        target[key] = sourceEntry
      }
      added++
    } else if (mode === 'replace') {
      // Replace mode - overwrite everything
      target[key] = sourceEntry
      updated++
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
    return file.json()
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
