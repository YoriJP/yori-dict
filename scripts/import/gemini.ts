/**
 * Gemini Importer - Backfill missing definitions for all language files
 *
 * Default workflow:
 *   - Use `data/lang/en.json` as the master key list
 *   - For each target language file, find entries with missing definitions
 *   - Ask Gemini to generate concise dictionary definitions
 *   - Save generated definitions with source `ai`
 *
 * Usage:
 *   bun run import:gemini
 *   bun run import:gemini --langs de,ko,zh-cn,zh-tw --limit 5000
 *   bun run import:gemini --dry-run
 */

import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  addLangDefinition,
  createEmptyLangEntry,
  isDefinitionArtifact,
  loadLang,
  parseKey,
  sanitizeDefinitionText,
  saveLang,
  type LangEntry,
  type LangFile,
} from './base'

type TargetLang = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'
type SeedLang = TargetLang | 'none'

interface CliOptions {
  langs: TargetLang[]
  seedLang: SeedLang
  model: string
  batchSize: number
  maxDefs: number
  saveEvery: number
  limit: number | null
  offset: number
  retries: number
  minDelayMs: number
  temperature: number
  dryRun: boolean
}

interface PromptItem {
  id: string
  word: string
  reading: string
  sourceDefinitions: string[]
}

interface GeminiCandidatePart {
  text?: string
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiCandidatePart[] }
  }>
}

const DATA_DIR = './data'
const LANG_DIR = `${DATA_DIR}/lang`
const ALL_LANGS: TargetLang[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504])

const LANG_NAME: Record<TargetLang, string> = {
  en: 'English',
  de: 'German',
  ko: 'Korean',
  'zh-cn': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese (Taiwan)',
}

const STYLE_HINT: Record<TargetLang, string> = {
  en: 'Use natural English dictionary glosses.',
  de: 'Use natural German dictionary glosses.',
  ko: 'Use natural Korean dictionary glosses in Hangul.',
  'zh-cn': 'Use only Simplified Chinese.',
  'zh-tw': 'Use only Traditional Chinese used in Taiwan.',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function parseFloatRange(value: string, name: string, min: number, max: number): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

function parseLangs(value: string): TargetLang[] {
  const tokens = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  const unique: TargetLang[] = []

  for (const token of tokens) {
    if (!ALL_LANGS.includes(token as TargetLang)) {
      throw new Error(`Unsupported language: ${token}`)
    }
    const lang = token as TargetLang
    if (!unique.includes(lang)) unique.push(lang)
  }

  if (unique.length === 0) {
    throw new Error('No valid languages provided')
  }
  return unique
}

function parseSeedLang(value: string): SeedLang {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'none') return 'none'
  if (ALL_LANGS.includes(normalized as TargetLang)) return normalized as TargetLang
  throw new Error(`Unsupported --seed-lang: ${value}`)
}

function normalizeModelName(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    langs: [...ALL_LANGS],
    seedLang: 'en',
    model: 'gemini-2.0-flash',
    batchSize: 20,
    maxDefs: 3,
    saveEvery: 10,
    limit: null,
    offset: 0,
    retries: 5,
    minDelayMs: 250,
    temperature: 0.2,
    dryRun: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if ((arg === '--langs' || arg === '--lang') && next) {
      opts.langs = parseLangs(next)
      i++
    } else if (arg === '--seed-lang' && next) {
      opts.seedLang = parseSeedLang(next)
      i++
    } else if (arg === '--model' && next) {
      opts.model = normalizeModelName(next)
      i++
    } else if (arg === '--batch-size' && next) {
      opts.batchSize = parsePositiveInt(next, '--batch-size')
      i++
    } else if (arg === '--max-defs' && next) {
      opts.maxDefs = parsePositiveInt(next, '--max-defs')
      i++
    } else if (arg === '--save-every' && next) {
      opts.saveEvery = parsePositiveInt(next, '--save-every')
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = parsePositiveInt(next, '--limit')
      i++
    } else if (arg === '--offset' && next) {
      opts.offset = parseNonNegativeInt(next, '--offset')
      i++
    } else if (arg === '--retries' && next) {
      opts.retries = parsePositiveInt(next, '--retries')
      i++
    } else if (arg === '--min-delay-ms' && next) {
      opts.minDelayMs = parseNonNegativeInt(next, '--min-delay-ms')
      i++
    } else if (arg === '--temperature' && next) {
      opts.temperature = parseFloatRange(next, '--temperature', 0, 2)
      i++
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function printHelp(): void {
  console.log(`
Gemini Importer

Backfills missing definitions in language files using Gemini API.

Environment:
  GEMINI_API_KEY or GOOGLE_API_KEY must be set (unless --dry-run)

Usage:
  bun run import:gemini [options]

Options:
  --langs <list>        Comma-separated targets (default: en,de,ko,zh-cn,zh-tw)
  --seed-lang <lang>    Master key/definition source language (default: en, use "none" to disable)
  --model <name>        Gemini model (default: gemini-2.0-flash)
  --batch-size <n>      Entries per API call (default: 20)
  --max-defs <n>        Max generated definitions per entry (default: 3)
  --save-every <n>      Save every N batches (default: 10)
  --limit <n>           Process at most N missing entries per language
  --offset <n>          Skip first N missing entries per language
  --retries <n>         Retry count per failed request (default: 5)
  --min-delay-ms <n>    Delay between requests in milliseconds (default: 250)
  --temperature <n>     Generation temperature 0-2 (default: 0.2)
  --dry-run             Preview missing counts without writing
  --help, -h            Show this help

Examples:
  bun run import:gemini --langs de,ko,zh-cn,zh-tw
  bun run import:gemini --limit 1000 --batch-size 10
  bun run import:gemini --dry-run
`)
}

function collectMissingKeys(
  masterKeys: string[],
  target: LangFile,
  offset: number,
  limit: number | null
): string[] {
  const missing: string[] = []

  for (const key of masterKeys) {
    const entry = target.entries[key]
    if (!entry || entry.definitions.length === 0) {
      missing.push(key)
    }
  }

  const start = Math.min(offset, missing.length)
  const end = limit === null ? missing.length : Math.min(start + limit, missing.length)
  return missing.slice(start, end)
}

function normalizeDefinitionList(raw: unknown, maxDefs: number): string[] {
  if (!Array.isArray(raw)) return []

  const defs: string[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (typeof item !== 'string') continue
    const cleaned = sanitizeDefinitionText(item)
    if (isDefinitionArtifact(cleaned)) continue

    const normalized = cleaned.toLowerCase().trim()
    if (!normalized || seen.has(normalized)) continue

    defs.push(cleaned)
    seen.add(normalized)
    if (defs.length >= maxDefs) break
  }

  return defs
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Gemini returned empty content')

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const raw = fenced ? fenced[1].trim() : trimmed

  const attempts: string[] = [raw]
  const firstObj = raw.indexOf('{')
  const lastObj = raw.lastIndexOf('}')
  if (firstObj >= 0 && lastObj > firstObj) {
    attempts.push(raw.slice(firstObj, lastObj + 1))
  }

  const firstArr = raw.indexOf('[')
  const lastArr = raw.lastIndexOf(']')
  if (firstArr >= 0 && lastArr > firstArr) {
    attempts.push(raw.slice(firstArr, lastArr + 1))
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      // continue
    }
  }

  throw new Error('Gemini response was not valid JSON')
}

function parseGeminiResult(
  text: string,
  allowedIds: Set<string>,
  maxDefs: number
): Map<string, string[]> {
  const parsed = extractJsonPayload(text)
  const map = new Map<string, string[]>()

  let items: unknown[] = []
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)) {
    items = (parsed as { items: unknown[] }).items
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as { id?: unknown; definitions?: unknown; defs?: unknown; glosses?: unknown }
    if (typeof row.id !== 'string' || !allowedIds.has(row.id)) continue

    const defsRaw = row.definitions ?? row.defs ?? row.glosses
    const defs = normalizeDefinitionList(defsRaw, maxDefs)
    map.set(row.id, defs)
  }

  return map
}

function buildPrompt(
  lang: TargetLang,
  sourceLang: SeedLang,
  maxDefs: number,
  items: PromptItem[]
): string {
  const sourceLabel = sourceLang === 'none' ? 'none' : LANG_NAME[sourceLang]
  return [
    `You are a multilingual dictionary editor.`,
    `Target language: ${LANG_NAME[lang]}.`,
    `Input source definition language: ${sourceLabel}.`,
    STYLE_HINT[lang],
    `Generate concise dictionary-style glosses.`,
    `Output strict JSON only in this shape:`,
    `{"items":[{"id":"<id>","definitions":["..."]}]}`,
    `Rules:`,
    `- Keep each "id" exactly as provided.`,
    `- Definitions must be short phrases, not full sentences.`,
    `- Do not add numbering, markdown, explanations, or comments.`,
    `- Provide 1 to ${maxDefs} definitions when possible; return [] if unknown.`,
    `- Do not include duplicate definitions within the same id.`,
    ``,
    `Items:`,
    JSON.stringify(items),
  ].join('\n')
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
  retries: number
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
          },
        }),
      })

      if (!response.ok) {
        const body = await response.text()
        const err = new Error(`Gemini API ${response.status}: ${body.slice(0, 300)}`)
        if (RETRYABLE_HTTP.has(response.status) && attempt < retries) {
          const backoff = Math.min(15000, 500 * 2 ** (attempt - 1))
          await sleep(backoff)
          continue
        }
        throw err
      }

      const json = await response.json() as GeminiResponse
      const parts = json.candidates?.[0]?.content?.parts ?? []
      const text = parts
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()

      if (!text) {
        throw new Error('Gemini returned no text content')
      }

      return text
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= retries) break
      const backoff = Math.min(15000, 500 * 2 ** (attempt - 1))
      await sleep(backoff)
    }
  }

  throw lastError ?? new Error('Gemini request failed')
}

function getSourceDefinitions(
  seedFile: LangFile | null,
  targetLang: TargetLang,
  seedLang: SeedLang,
  key: string
): string[] {
  if (!seedFile) return []
  if (seedLang !== 'none' && targetLang === seedLang) return []
  return (seedFile.entries[key]?.definitions ?? []).slice(0, 4)
}

function buildPromptItems(
  keys: string[],
  targetLang: TargetLang,
  seedLang: SeedLang,
  seedFile: LangFile | null
): PromptItem[] {
  return keys.map((key) => {
    const { word, reading } = parseKey(key)
    return {
      id: key,
      word,
      reading,
      sourceDefinitions: getSourceDefinitions(seedFile, targetLang, seedLang, key),
    }
  })
}

function ensureEntry(target: LangFile, key: string): LangEntry {
  const existing = target.entries[key]
  if (existing) return existing
  const created = createEmptyLangEntry()
  target.entries[key] = created
  return created
}

async function processLanguage(
  lang: TargetLang,
  opts: CliOptions,
  masterKeys: string[],
  seedFile: LangFile | null,
  apiKey: string | null
): Promise<void> {
  const langPath = `${LANG_DIR}/${lang}.json`
  const target = await loadLang(langPath, lang)
  const missingKeys = collectMissingKeys(masterKeys, target, opts.offset, opts.limit)

  console.log(`\n=== ${lang} ===`)
  console.log(`Missing entries selected: ${missingKeys.length.toLocaleString()}`)

  if (missingKeys.length === 0) {
    console.log('Nothing to fill.')
    return
  }

  if (opts.dryRun) {
    const preview = missingKeys.slice(0, 5).map((k) => {
      const { word, reading } = parseKey(k)
      return `${word} [${reading}]`
    })
    console.log('Dry-run preview:')
    for (const row of preview) console.log(`  - ${row}`)
    return
  }

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY/GOOGLE_API_KEY is required')
  }

  let batches = 0
  let failedBatches = 0
  let updatedEntries = 0
  let addedDefinitions = 0

  for (let i = 0; i < missingKeys.length; i += opts.batchSize) {
    const batchKeys = missingKeys.slice(i, i + opts.batchSize)
    const items = buildPromptItems(batchKeys, lang, opts.seedLang, seedFile)
    const prompt = buildPrompt(lang, opts.seedLang, opts.maxDefs, items)
    const allowedIds = new Set(batchKeys)
    batches++

    process.stdout.write(
      `\r  Batch ${batches.toLocaleString()} ` +
      `(${Math.min(i + opts.batchSize, missingKeys.length).toLocaleString()}/${missingKeys.length.toLocaleString()})`
    )

    try {
      const raw = await callGemini(apiKey, opts.model, prompt, opts.temperature, opts.retries)
      const result = parseGeminiResult(raw, allowedIds, opts.maxDefs)

      for (const key of batchKeys) {
        const defs = result.get(key) ?? []
        if (defs.length === 0) continue

        const entry = ensureEntry(target, key)
        const before = entry.definitions.length

        for (const def of defs) {
          addLangDefinition(entry, def, 'ai')
        }

        const delta = entry.definitions.length - before
        if (delta > 0) {
          updatedEntries++
          addedDefinitions += delta
        }
      }
    } catch (error) {
      failedBatches++
      const message = error instanceof Error ? error.message : String(error)
      console.log(`\n  Batch failed: ${message}`)
    }

    if (opts.minDelayMs > 0 && i + opts.batchSize < missingKeys.length) {
      await sleep(opts.minDelayMs)
    }

    if (batches % opts.saveEvery === 0) {
      await saveLang(langPath, target)
    }
  }

  console.log('')
  await saveLang(langPath, target)

  console.log(`Batches: ${batches.toLocaleString()} (failed: ${failedBatches.toLocaleString()})`)
  console.log(`Updated entries: ${updatedEntries.toLocaleString()}`)
  console.log(`Added definitions: ${addedDefinitions.toLocaleString()}`)
  console.log(`Saved: ${langPath}`)
}

async function loadSeedFile(seedLang: SeedLang): Promise<LangFile | null> {
  if (seedLang === 'none') return null
  const path = `${LANG_DIR}/${seedLang}.json`
  if (!existsSync(path)) {
    throw new Error(`Seed language file not found: ${path}`)
  }
  console.log(`Loading seed language: ${seedLang}`)
  return loadLang(path, seedLang)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null

  console.log('=== [AI] Gemini Definition Backfill ===')
  console.log(`Languages: ${opts.langs.join(', ')}`)
  console.log(`Seed language: ${opts.seedLang}`)
  console.log(`Model: ${opts.model}`)
  console.log(`Batch size: ${opts.batchSize}`)
  console.log(`Max definitions per entry: ${opts.maxDefs}`)
  console.log(`Offset: ${opts.offset.toLocaleString()}`)
  console.log(`Limit: ${opts.limit === null ? 'none' : opts.limit.toLocaleString()}`)
  console.log(`Dry run: ${opts.dryRun ? 'yes' : 'no'}`)

  if (!opts.dryRun && !apiKey) {
    throw new Error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) before running this script')
  }

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  const masterPath = `${LANG_DIR}/en.json`
  if (!existsSync(masterPath)) {
    throw new Error(`Master language file not found: ${masterPath}`)
  }
  console.log('Loading master key list: en')
  const masterFile = await loadLang(masterPath, 'en')
  const masterKeys = Object.keys(masterFile.entries)

  const seedFile = opts.seedLang === 'en'
    ? masterFile
    : await loadSeedFile(opts.seedLang)

  console.log(`Master key count: ${masterKeys.length.toLocaleString()}`)

  for (const lang of opts.langs) {
    await processLanguage(lang, opts, masterKeys, seedFile, apiKey)
  }

  console.log('\n=== Done ===')
}

main().catch((error) => {
  console.error('Import failed:', error)
  process.exit(1)
})
