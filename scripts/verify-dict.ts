/**
 * Dictionary quality verifier.
 *
 * Checks:
 * - duplicate definitions within an entry (case-insensitive, trimmed)
 * - residual markup artifacts in definition text (e.g. "<...>", "HW n:")
 *
 * Usage:
 *   bun run scripts/verify-dict.ts data/de.json
 *   bun run scripts/verify-dict.ts data/de.json --fail-on-issues
 */

import { existsSync } from 'fs'
import { normalizeText } from './import/base'

type DictDefinition = {
  text: string
  sources: string[]
}

type DictEntry = {
  definitions?: DictDefinition[]
}

type DictFile = {
  entries: Record<string, DictEntry>
}

const dictPath = process.argv[2]
const failOnIssues = process.argv.includes('--fail-on-issues')

if (!dictPath) {
  console.error('Usage: bun run scripts/verify-dict.ts <path> [--fail-on-issues]')
  process.exit(1)
}

if (!existsSync(dictPath)) {
  console.error(`Dictionary file not found: ${dictPath}`)
  process.exit(1)
}

const dict = await Bun.file(dictPath).json() as DictFile
const entries = dict.entries || {}

const suspiciousPattern = /(^|[\s(])\{?\s*HW\s+[a-z]{1,4}\s*:|<[^>]+>/i

let definitionsTotal = 0
let entriesWithDupDefs = 0
let duplicateDefsTotal = 0
let suspiciousDefsTotal = 0

const dupSamples: Array<{ key: string; text: string }> = []
const suspiciousSamples: Array<{ key: string; text: string; sources: string[] }> = []

for (const [key, entry] of Object.entries(entries)) {
  const defs = entry.definitions || []
  definitionsTotal += defs.length

  // Track normalized text → sources seen so far for this entry.
  // A duplicate is only flagged when the same text appears with overlapping
  // sources — matching the intentional behaviour of mergeDefinitions() in
  // base.ts, which keeps same-text defs with disjoint sources as separate entries.
  const seen = new Map<string, string[]>()
  let entryDupCount = 0

  for (const def of defs) {
    const text = String(def.text ?? '').trim()
    const normalized = normalizeText(text)
    const sources = Array.isArray(def.sources) ? def.sources : []

    const prevSources = seen.get(normalized)
    if (prevSources !== undefined) {
      const overlaps = sources.some((s) => prevSources.includes(s))
      if (overlaps) {
        entryDupCount++
        duplicateDefsTotal++
        if (dupSamples.length < 10) {
          dupSamples.push({ key, text })
        }
      }
    } else {
      seen.set(normalized, sources)
    }

    if (suspiciousPattern.test(text)) {
      suspiciousDefsTotal++
      if (suspiciousSamples.length < 10) {
        suspiciousSamples.push({
          key,
          text,
          sources: Array.isArray(def.sources) ? def.sources : [],
        })
      }
    }
  }

  if (entryDupCount > 0) {
    entriesWithDupDefs++
  }
}

const hasIssues = duplicateDefsTotal > 0 || suspiciousDefsTotal > 0

console.log(`\n=== Dictionary Verification: ${dictPath} ===`)
console.log(`Entries: ${Object.keys(entries).length.toLocaleString()}`)
console.log(`Definitions: ${definitionsTotal.toLocaleString()}`)
console.log('\nIssues:')
console.log(`  Entries with duplicate definitions: ${entriesWithDupDefs.toLocaleString()}`)
console.log(`  Duplicate definitions total: ${duplicateDefsTotal.toLocaleString()}`)
console.log(`  Suspicious definition fragments: ${suspiciousDefsTotal.toLocaleString()}`)

if (dupSamples.length > 0) {
  console.log('\nDuplicate samples:')
  for (const sample of dupSamples) {
    console.log(`  - ${sample.key} -> ${sample.text}`)
  }
}

if (suspiciousSamples.length > 0) {
  console.log('\nSuspicious samples:')
  for (const sample of suspiciousSamples) {
    console.log(`  - ${sample.key} -> ${sample.text} [${sample.sources.join(', ')}]`)
  }
}

if (!hasIssues) {
  console.log('\nResult: PASS')
} else {
  console.log('\nResult: FAIL')
}

if (hasIssues && failOnIssues) {
  process.exit(1)
}
