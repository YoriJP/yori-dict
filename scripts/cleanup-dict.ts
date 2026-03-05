/**
 * Dictionary cleanup script — removes duplicate definitions, empty parens, and empty definitions.
 *
 * Supports both new-schema files:
 *   data/core.json       — structural cleanup only (no definitions)
 *   data/lang/*.json     — clean definitions (string[]) and _defSources
 *
 * Usage:
 *   bun run scripts/cleanup-dict.ts data/lang/de.json              # preview
 *   bun run scripts/cleanup-dict.ts data/lang/de.json --apply       # apply changes
 *   bun run scripts/cleanup-dict.ts data/core.json --apply          # core file
 */

import { loadLang, saveLang } from './import/base'
import type { LangFile } from './import/base'

const dictPath = process.argv[2]
const apply = process.argv.includes('--apply')

if (!dictPath) {
  console.error('Usage: bun run scripts/cleanup-dict.ts <path> [--apply]')
  process.exit(1)
}

const raw = await Bun.file(dictPath).json() as { version?: string; lang?: string; entries?: Record<string, unknown> }

if (raw.version !== '2.0.0') {
  console.error(`Unsupported file format (version: ${raw.version ?? 'unknown'}).`)
  console.error('This script supports v2.0.0 files (data/core.json, data/lang/*.json).')
  process.exit(1)
}

const isCoreFile = !raw.lang
const isLangFile = !!raw.lang

if (isCoreFile) {
  const entries = Object.keys(raw.entries ?? {})
  console.log(`\n=== Dictionary Cleanup: ${dictPath} (core) ===`)
  console.log(`Entries: ${entries.length.toLocaleString()}`)
  console.log('Core file — no definition cleanup needed.')
  process.exit(0)
}

if (!isLangFile) {
  console.error('Could not detect file type.')
  process.exit(1)
}

// Lang file cleanup
const lang = raw.lang as string
const langFile = await loadLang(dictPath, lang)

const entries = Object.values(langFile.entries)
const defsBefore = entries.reduce((n, e) => n + e.definitions.length, 0)

let dupsRemoved = 0
let parensFixed = 0
let emptyRemoved = 0
let entriesModified = 0

for (const entry of entries) {
  let modified = false

  // Step 1: Strip trailing empty parens and fix _defSources keys
  const fixedDefs: string[] = []
  for (const def of entry.definitions) {
    let text = def

    if (text.endsWith(' ()')) {
      const fixed = text.slice(0, -3)
      parensFixed++
      modified = true

      // Migrate _defSources key from old text to fixed text
      if (entry._defSources[def] !== undefined && entry._defSources[fixed] === undefined) {
        entry._defSources[fixed] = entry._defSources[def]
      }
      delete entry._defSources[def]
      text = fixed
    }

    if (text.trim() === '') {
      emptyRemoved++
      delete entry._defSources[def]
      modified = true
      continue
    }

    fixedDefs.push(text)
  }

  // Step 2: Deduplicate definitions case-insensitively, merging _defSources
  const seen = new Map<string, string>() // normalized → canonical text
  const cleaned: string[] = []

  for (const def of fixedDefs) {
    const normalized = def.toLowerCase().trim()
    const canonical = seen.get(normalized)

    if (canonical !== undefined) {
      // Merge sources of duplicate into canonical
      const canonicalSources = entry._defSources[canonical] ?? []
      const thisSources = entry._defSources[def] ?? []
      const merged = [...new Set([...canonicalSources, ...thisSources])]
      if (merged.length > 0) {
        entry._defSources[canonical] = merged
      }
      delete entry._defSources[def]
      dupsRemoved++
      modified = true
    } else {
      seen.set(normalized, def)
      cleaned.push(def)
    }
  }

  // Step 3: Remove orphaned _defSources entries (sources for non-existent defs)
  const defSet = new Set(cleaned)
  for (const key of Object.keys(entry._defSources)) {
    if (!defSet.has(key)) {
      delete entry._defSources[key]
      modified = true
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
  await saveLang(dictPath, langFile)
  console.log(`\n(Changes written to ${dictPath})`)
} else {
  console.log('\n(Preview mode — no changes written. Use --apply to save.)')
}
