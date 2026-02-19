/**
 * Dictionary cleanup script — removes duplicate definitions, empty parens, and empty definitions.
 *
 * Usage:
 *   bun run scripts/cleanup-dict.ts data/de.json              # preview
 *   bun run scripts/cleanup-dict.ts data/de.json --apply       # apply changes
 */

import { loadDict, saveDict, normalizeText, mergeArrays } from './import/base'
import type { DictFile, DictEntry, Definition } from './import/base'

const dictPath = process.argv[2]
const apply = process.argv.includes('--apply')

if (!dictPath) {
  console.error('Usage: bun run scripts/cleanup-dict.ts <path> [--apply]')
  process.exit(1)
}

// Extract lang from filename (e.g. "data/de.json" → "de")
const lang = dictPath.match(/([a-z]{2})\.json$/)?.[1] ?? 'unknown'
const dict = await loadDict(dictPath, lang)

const entries = Object.values(dict.entries)
const defsBefore = entries.reduce((n, e) => n + e.definitions.length, 0)

let dupsRemoved = 0
let parensFixed = 0
let emptyRemoved = 0
let entriesModified = 0

for (const entry of entries) {
  const original = entry.definitions.length
  let modified = false

  // 1. Strip trailing empty parens & remove empty definitions
  const stripped: Definition[] = []
  for (const def of entry.definitions) {
    let text = def.text

    if (text.endsWith(' ()')) {
      text = text.slice(0, -3)
      parensFixed++
      modified = true
    }

    if (text.trim() === '') {
      emptyRemoved++
      modified = true
      continue
    }

    stripped.push({ text, sources: [...def.sources] })
  }

  // 2. Deduplicate definitions (normalize by lowercase+trim, keep first, merge sources)
  const cleaned: Definition[] = []
  const seen = new Map<string, Definition>()

  for (const def of stripped) {
    const key = normalizeText(def.text)
    const existing = seen.get(key)
    if (existing) {
      existing.sources = mergeArrays(existing.sources, def.sources)
      dupsRemoved++
      modified = true
    } else {
      seen.set(key, def)
      cleaned.push(def)
    }
  }

  if (modified) {
    entry.definitions = cleaned
    entriesModified++
  }
}

const defsAfter = entries.reduce((n, e) => n + e.definitions.length, 0)

console.log(`\n=== Dictionary Cleanup: ${dictPath} ===`)
console.log(`Entries: ${entries.length.toLocaleString()} | Definitions: ${defsBefore.toLocaleString()}\n`)
console.log('Results:')
console.log(`  Duplicate definitions removed: ${dupsRemoved.toLocaleString()}`)
console.log(`  Empty parens fixed: ${parensFixed.toLocaleString()}`)
console.log(`  Empty definitions removed: ${emptyRemoved.toLocaleString()}`)
console.log(`  Entries modified: ${entriesModified.toLocaleString()}`)
console.log(`  Definitions after: ${defsAfter.toLocaleString()}`)

if (apply) {
  await saveDict(dictPath, dict)
  console.log(`\n(Changes written to ${dictPath})`)
} else {
  console.log('\n(Preview mode — no changes written. Use --apply to save.)')
}
