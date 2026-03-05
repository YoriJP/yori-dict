/**
 * Dictionary quality verifier.
 *
 * Supports both new-schema files:
 *   data/core.json       — checks structural integrity (word, reading, POS, jlpt, frequency)
 *   data/lang/*.json     — checks duplicate definitions, artifacts, _defSources consistency
 *
 * Usage:
 *   bun run scripts/verify-dict.ts data/lang/de.json
 *   bun run scripts/verify-dict.ts data/core.json
 *   bun run scripts/verify-dict.ts data/lang/de.json --fail-on-issues
 */

import { existsSync } from 'fs'

const dictPath = process.argv[2]
const failOnIssues = process.argv.includes('--fail-on-issues')

if (!dictPath) {
  console.error('Usage: bun run scripts/verify-dict.ts <path> [--fail-on-issues]')
  process.exit(1)
}

if (!existsSync(dictPath)) {
  console.error(`File not found: ${dictPath}`)
  process.exit(1)
}

const raw = await Bun.file(dictPath).json() as {
  version?: string
  lang?: string
  entries?: Record<string, unknown>
}

if (raw.version !== '2.0.0') {
  console.error(`Unsupported file format (version: ${raw.version ?? 'unknown'}).`)
  console.error('This script supports v2.0.0 files (data/core.json, data/lang/*.json).')
  process.exit(1)
}

const isCoreFile = !raw.lang
const entries = raw.entries ?? {}

// ============================================================================
// Verify core.json
// ============================================================================

if (isCoreFile) {
  type CoreEntry = {
    word?: unknown
    reading?: unknown
    partOfSpeech?: unknown
    common?: unknown
    jlpt?: unknown
    frequency?: unknown
  }

  let invalidEntries = 0
  let invalidJlpt = 0
  let invalidFrequency = 0
  let missingWord = 0
  let missingReading = 0

  const invalidSamples: string[] = []

  for (const [key, rawEntry] of Object.entries(entries)) {
    const entry = rawEntry as CoreEntry
    let entryInvalid = false

    if (!entry.word || typeof entry.word !== 'string') { missingWord++; entryInvalid = true }
    if (!entry.reading || typeof entry.reading !== 'string') { missingReading++; entryInvalid = true }
    if (!Array.isArray(entry.partOfSpeech)) { entryInvalid = true }
    if (typeof entry.common !== 'boolean') { entryInvalid = true }

    if (entry.jlpt !== null && entry.jlpt !== undefined) {
      if (typeof entry.jlpt !== 'number' || entry.jlpt < 1 || entry.jlpt > 5) {
        invalidJlpt++
        entryInvalid = true
      }
    }

    if (entry.frequency !== null && entry.frequency !== undefined) {
      if (typeof entry.frequency !== 'number' || entry.frequency < 1) {
        invalidFrequency++
        entryInvalid = true
      }
    }

    if (entryInvalid) {
      invalidEntries++
      if (invalidSamples.length < 10) invalidSamples.push(key)
    }
  }

  const hasIssues = invalidEntries > 0 || invalidJlpt > 0 || invalidFrequency > 0

  console.log(`\n=== Dictionary Verification: ${dictPath} (core) ===`)
  console.log(`Entries: ${Object.keys(entries).length.toLocaleString()}`)
  console.log('\nIssues:')
  console.log(`  Invalid entries: ${invalidEntries.toLocaleString()}`)
  console.log(`  Missing word: ${missingWord.toLocaleString()}`)
  console.log(`  Missing reading: ${missingReading.toLocaleString()}`)
  console.log(`  Invalid jlpt values: ${invalidJlpt.toLocaleString()}`)
  console.log(`  Invalid frequency values: ${invalidFrequency.toLocaleString()}`)

  if (invalidSamples.length > 0) {
    console.log('\nInvalid entry samples:')
    for (const key of invalidSamples) {
      console.log(`  - ${key}`)
    }
  }

  console.log(`\nResult: ${hasIssues ? 'FAIL' : 'PASS'}`)
  if (hasIssues && failOnIssues) process.exit(1)
  process.exit(0)
}

// ============================================================================
// Verify lang/*.json
// ============================================================================

type LangEntry = {
  definitions?: unknown[]
  examples?: unknown[]
  _defSources?: Record<string, unknown>
}

const suspiciousPattern = /(^|[\s(])\{?\s*HW\s+[a-z]{1,4}\s*:|<[^>]+>/i

let definitionsTotal = 0
let entriesWithDupDefs = 0
let duplicateDefsTotal = 0
let suspiciousDefsTotal = 0
let defSourcesOrphans = 0
let defSourcesMissing = 0

const dupSamples: Array<{ key: string; text: string }> = []
const suspiciousSamples: Array<{ key: string; text: string; sources: string[] }> = []

for (const [key, rawEntry] of Object.entries(entries)) {
  const entry = rawEntry as LangEntry
  const defs = (entry.definitions ?? []) as unknown[]
  const defSources = entry._defSources ?? {}

  definitionsTotal += defs.length

  // Check for duplicate definitions (case-insensitive)
  const seen = new Map<string, string>() // normalized → original
  let entryDupCount = 0

  for (const rawDef of defs) {
    const text = String(rawDef).trim()
    const normalized = text.toLowerCase()

    if (seen.has(normalized)) {
      entryDupCount++
      duplicateDefsTotal++
      if (dupSamples.length < 10) {
        dupSamples.push({ key, text })
      }
    } else {
      seen.set(normalized, text)
    }

    // Check for suspicious markup artifacts
    if (suspiciousPattern.test(text)) {
      suspiciousDefsTotal++
      const sources = Array.isArray(defSources[text]) ? (defSources[text] as string[]) : []
      if (suspiciousSamples.length < 10) {
        suspiciousSamples.push({ key, text, sources })
      }
    }
  }

  if (entryDupCount > 0) entriesWithDupDefs++

  // Check _defSources consistency
  const defSet = new Set(defs.map(String))
  // Missing: defs without _defSources entry
  for (const def of defs) {
    if (!defSources[String(def)]) defSourcesMissing++
  }
  // Orphaned: _defSources entries for non-existent defs
  for (const srcKey of Object.keys(defSources)) {
    if (!defSet.has(srcKey)) defSourcesOrphans++
  }
}

const hasIssues =
  duplicateDefsTotal > 0 ||
  suspiciousDefsTotal > 0 ||
  defSourcesOrphans > 0

console.log(`\n=== Dictionary Verification: ${dictPath} ===`)
console.log(`Entries: ${Object.keys(entries).length.toLocaleString()}`)
console.log(`Definitions: ${definitionsTotal.toLocaleString()}`)
console.log('\nIssues:')
console.log(`  Entries with duplicate definitions: ${entriesWithDupDefs.toLocaleString()}`)
console.log(`  Duplicate definitions total: ${duplicateDefsTotal.toLocaleString()}`)
console.log(`  Suspicious definition fragments: ${suspiciousDefsTotal.toLocaleString()}`)
console.log(`  Orphaned _defSources entries: ${defSourcesOrphans.toLocaleString()}`)
console.log(`  Definitions missing from _defSources: ${defSourcesMissing.toLocaleString()} (informational)`)

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

console.log(`\nResult: ${hasIssues ? 'FAIL' : 'PASS'}`)

if (hasIssues && failOnIssues) {
  process.exit(1)
}
