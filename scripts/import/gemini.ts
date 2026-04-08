/**
 * Gemini Importer - Backfill missing definitions for all language files
 *
 * Default workflow:
 *   - Use `data/lang/en.json` as the master key list
 *   - Filter to the most useful missing entries using core metadata
 *   - Ask Gemini SDK to generate concise dictionary definitions
 *   - Save generated definitions with source `ai`
 *   - Track tokens and estimated spend for safer runs
 *
 * Usage:
 *   bun run import:gemini
 *   bun run import:gemini --langs zh-tw --common-only --min-frequency 10000 --limit 5000
 *   bun run import:gemini --max-cost-usd 2 --report-file reports/gemini.json
 *   bun run import:gemini --dry-run
 */

import { GoogleGenAI } from '@google/genai'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  addLangDefinition,
  createEmptyLangEntry,
  isDefinitionArtifact,
  loadCore,
  loadLang,
  parseKey,
  sanitizeDefinitionText,
  saveLang,
  type CoreEntry,
  type LangEntry,
  type LangFile,
} from './base'
import {
  requireActiveReleaseConfig,
  type ReleaseSnapshot,
} from '../../src/storage'
import { finalizeUpdateBatch, initUpdatesDatabase, insertTranslationUpdate, insertUpdateBatch } from '../../src/update-store'
import { applyActiveUpdatesToSnapshot, loadSnapshotFromReleaseDb } from '../release/lib'

type TargetLang = 'en' | 'de' | 'ko' | 'zh-cn' | 'zh-tw'
type SeedLang = TargetLang | 'none'
type OutputMode = 'json' | 'updates-db'

export interface CliOptions {
  langs: TargetLang[]
  seedLang: SeedLang
  outputMode: OutputMode
  model: string
  batchSize: number
  maxDefs: number
  saveEvery: number
  limit: number | null
  offset: number
  retries: number
  minDelayMs: number
  temperature: number
  commonOnly: boolean
  minFrequency: number | null
  jlptMax: number | null
  excludeRegex: string | null
  maxInputTokens: number | null
  maxCostUsd: number | null
  reportFile: string | null
  inputPricePer1M: number | null
  outputPricePer1M: number | null
  dryRun: boolean
}

export interface GeminiRunOptions extends CliOptions {
  actor?: string | null
}

interface PromptItem {
  id: string
  word: string
  reading: string
  sourceDefinitions: string[]
}

export interface SelectionFilters {
  commonOnly: boolean
  minFrequency: number | null
  jlptMax: number | null
  excludePattern: RegExp | null
}

export interface MissingSelectionResult {
  totalMissing: number
  eligibleMissing: number
  pagedMissing: number
  excludedByCommon: number
  excludedByFrequency: number
  excludedByJlpt: number
  excludedByRegex: number
  keys: string[]
}

export interface UsageStats {
  promptTokens: number
  candidateTokens: number
  thoughtsTokens: number
  totalTokens: number
}

export interface PricingConfig {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

interface GenerateResult {
  text: string
  usage: UsageStats
}

interface RunTotals {
  promptTokens: number
  candidateTokens: number
  thoughtsTokens: number
  totalTokens: number
  estimatedCostUsd: number
  countRequests: number
  generateRequests: number
  generatedEntries: number
}

interface LanguageReport {
  lang: TargetLang
  totalMissing: number
  eligibleMissing: number
  pagedMissing: number
  excludedByCommon: number
  excludedByFrequency: number
  excludedByJlpt: number
  excludedByRegex: number
  batches: number
  failedBatches: number
  updatedEntries: number
  addedDefinitions: number
  promptTokens: number
  candidateTokens: number
  thoughtsTokens: number
  totalTokens: number
  estimatedCostUsd: number
  stoppedReason: 'none' | 'budget' | 'max-input-tokens'
}

interface RunReport {
  generatedAt: string
  model: string
  dryRun: boolean
  pricing: PricingConfig | null
  options: {
    langs: TargetLang[]
    seedLang: SeedLang
    outputMode: OutputMode
    batchSize: number
    maxDefs: number
    saveEvery: number
    limit: number | null
    offset: number
    retries: number
    minDelayMs: number
    temperature: number
    commonOnly: boolean
    minFrequency: number | null
    jlptMax: number | null
    excludeRegex: string | null
    maxInputTokens: number | null
    maxCostUsd: number | null
    reportFile: string | null
  }
  totals: RunTotals
  languages: LanguageReport[]
}

const DATA_DIR = './data'
const CORE_PATH = `${DATA_DIR}/core.json`
const LANG_DIR = `${DATA_DIR}/lang`
const ALL_LANGS: TargetLang[] = ['en', 'de', 'ko', 'zh-cn', 'zh-tw']

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

const MODEL_PRICING: Record<string, PricingConfig> = {
  'gemini-3.1-flash-lite-preview': {
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 1.5,
  },
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

function parsePositiveFloat(value: string, name: string): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`)
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

export function normalizeModelName(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

export function defaultCliOptions(): CliOptions {
  return {
    langs: [...ALL_LANGS],
    seedLang: 'en',
    outputMode: 'updates-db',
    model: 'gemini-3.1-flash-lite-preview',
    batchSize: 20,
    maxDefs: 3,
    saveEvery: 10,
    limit: null,
    offset: 0,
    retries: 5,
    minDelayMs: 250,
    temperature: 0.2,
    commonOnly: false,
    minFrequency: null,
    jlptMax: null,
    excludeRegex: null,
    maxInputTokens: null,
    maxCostUsd: null,
    reportFile: null,
    inputPricePer1M: null,
    outputPricePer1M: null,
    dryRun: false,
  }
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = defaultCliOptions()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if ((arg === '--langs' || arg === '--lang') && next) {
      opts.langs = parseLangs(next)
      i++
    } else if (arg === '--seed-lang' && next) {
      opts.seedLang = parseSeedLang(next)
      i++
    } else if (arg === '--output-mode' && next) {
      if (next !== 'json' && next !== 'updates-db') {
        throw new Error(`Unsupported --output-mode: ${next}`)
      }
      opts.outputMode = next
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
    } else if (arg === '--min-frequency' && next) {
      opts.minFrequency = parsePositiveInt(next, '--min-frequency')
      i++
    } else if (arg === '--jlpt-max' && next) {
      opts.jlptMax = parsePositiveInt(next, '--jlpt-max')
      i++
      if (opts.jlptMax !== null && opts.jlptMax > 5) {
        throw new Error('--jlpt-max must be between 1 and 5')
      }
    } else if (arg === '--exclude-regex' && next) {
      opts.excludeRegex = next
      i++
    } else if (arg === '--max-input-tokens' && next) {
      opts.maxInputTokens = parsePositiveInt(next, '--max-input-tokens')
      i++
    } else if (arg === '--max-cost-usd' && next) {
      opts.maxCostUsd = parsePositiveFloat(next, '--max-cost-usd')
      i++
    } else if (arg === '--report-file' && next) {
      opts.reportFile = next
      i++
    } else if (arg === '--input-price-per-1m' && next) {
      opts.inputPricePer1M = parsePositiveFloat(next, '--input-price-per-1m')
      i++
    } else if (arg === '--output-price-per-1m' && next) {
      opts.outputPricePer1M = parsePositiveFloat(next, '--output-price-per-1m')
      i++
    } else if (arg === '--common-only') {
      opts.commonOnly = true
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

Backfills missing definitions in language files using the Gemini SDK.

Environment:
  GEMINI_API_KEY or GOOGLE_API_KEY must be set (unless --dry-run)

Usage:
  bun run import:gemini [options]

Options:
  --langs <list>             Comma-separated targets (default: en,de,ko,zh-cn,zh-tw)
  --seed-lang <lang>         Master key/definition source language (default: en, use "none" to disable)
  --output-mode <mode>       json | updates-db (default: updates-db)
  --model <name>             Gemini model for SDK calls (default: gemini-3.1-flash-lite-preview)
  --batch-size <n>           Entries per API call (default: 20)
  --max-defs <n>             Max generated definitions per entry (default: 3)
  --save-every <n>           Save every N batches (default: 10)
  --limit <n>                Process at most N filtered missing entries per language
  --offset <n>               Skip first N filtered missing entries per language
  --retries <n>              Retry count per failed request (default: 5)
  --min-delay-ms <n>         Delay between requests in milliseconds (default: 250)
  --temperature <n>          Generation temperature 0-2 (default: 0.2)
  --common-only              Only generate for entries marked common in core.json
  --min-frequency <rank>     Only include entries with frequency <= rank
  --jlpt-max <n>             Only include entries at or easier than N<n> (e.g. 3 keeps N3-N5)
  --exclude-regex <pattern>  Skip entries whose word/reading/key matches this JavaScript regex
  --max-input-tokens <n>     Stop if a batch prompt exceeds this many input tokens
  --max-cost-usd <n>         Stop before the next batch would exceed this estimated spend
  --report-file <path>       Write a JSON run report with filters, usage, and estimated cost
  --input-price-per-1m <n>   Override input token price per 1M tokens for cost estimation
  --output-price-per-1m <n>  Override output token price per 1M tokens for cost estimation
  --dry-run                  Preview filtered counts without writing
  --help, -h                 Show this help

Examples:
  bun run import:gemini --langs zh-tw --common-only --min-frequency 10000 --limit 5000
  bun run import:gemini --output-mode json --langs zh-tw --limit 500
  bun run import:gemini --langs de --jlpt-max 3 --max-cost-usd 2 --report-file reports/gemini-de.json
  bun run import:gemini --dry-run --exclude-regex '^[\\p{P}\\p{S}]+$'
`)
}

export function buildSelectionFilters(opts: CliOptions): SelectionFilters {
  let excludePattern: RegExp | null = null

  if (opts.excludeRegex) {
    try {
      excludePattern = new RegExp(opts.excludeRegex, 'u')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid --exclude-regex: ${message}`)
    }
  }

  return {
    commonOnly: opts.commonOnly,
    minFrequency: opts.minFrequency,
    jlptMax: opts.jlptMax,
    excludePattern,
  }
}

function buildCoreEntriesFromSnapshot(snapshot: ReleaseSnapshot): Record<string, CoreEntry> {
  const entries: Record<string, CoreEntry> = {}
  for (const [key, word] of snapshot.words) {
    entries[key] = {
      word: word.word,
      reading: word.reading,
      partOfSpeech: word.partOfSpeech,
      common: word.common,
      jlpt: word.jlpt.length > 0 ? word.jlpt[0] ?? null : null,
      frequency: word.frequency,
    }
  }
  return entries
}

function buildLangViewFromSnapshot(snapshot: ReleaseSnapshot, lang: TargetLang): LangFile {
  const langFile: LangFile = {
    version: '2.0.0',
    lang,
    updatedAt: new Date().toISOString(),
    stats: {
      entries: 0,
      withExamples: 0,
      sources: {},
    },
    entries: {},
  }

  for (const [key, translation] of snapshot.translations) {
    const [, translationLang] = key.split('\u0000')
    if (translationLang !== lang) continue

    const examples = snapshot.examples.get(key) ?? []
    langFile.entries[translation.wordId] = {
      definitions: translation.definitions,
      examples: examples.map((example) => ({
        ja: example.japanese,
        text: example.translation,
        source: example.source,
      })),
      _defSources: Object.fromEntries(
        translation.definitions.map((definition) => [definition, [...translation.sources]])
      ),
    }
  }

  return langFile
}

function matchesExcludePattern(pattern: RegExp | null, key: string): boolean {
  if (!pattern) return false
  const { word, reading } = parseKey(key)
  pattern.lastIndex = 0
  if (pattern.test(key)) return true
  pattern.lastIndex = 0
  if (pattern.test(word)) return true
  pattern.lastIndex = 0
  return pattern.test(reading)
}

function compareMissingKeys(
  leftKey: string,
  rightKey: string,
  coreEntries: Record<string, CoreEntry>
): number {
  const left = coreEntries[leftKey]
  const right = coreEntries[rightKey]

  const commonDelta = Number(Boolean(right?.common)) - Number(Boolean(left?.common))
  if (commonDelta !== 0) return commonDelta

  const leftFrequency = left?.frequency ?? Number.MAX_SAFE_INTEGER
  const rightFrequency = right?.frequency ?? Number.MAX_SAFE_INTEGER
  if (leftFrequency !== rightFrequency) return leftFrequency - rightFrequency

  const leftJlpt = left?.jlpt ?? 0
  const rightJlpt = right?.jlpt ?? 0
  if (leftJlpt !== rightJlpt) return rightJlpt - leftJlpt

  return leftKey.localeCompare(rightKey)
}

export function collectMissingKeys(
  masterKeys: string[],
  target: LangFile,
  coreEntries: Record<string, CoreEntry>,
  filters: SelectionFilters,
  offset: number,
  limit: number | null
): MissingSelectionResult {
  const eligible: string[] = []
  let totalMissing = 0
  let excludedByCommon = 0
  let excludedByFrequency = 0
  let excludedByJlpt = 0
  let excludedByRegex = 0

  for (const key of masterKeys) {
    const entry = target.entries[key]
    if (entry && entry.definitions.length > 0) continue

    totalMissing++
    const coreEntry = coreEntries[key]

    if (filters.commonOnly && !coreEntry?.common) {
      excludedByCommon++
      continue
    }

    if (filters.minFrequency !== null) {
      if (coreEntry?.frequency === null || coreEntry?.frequency === undefined || coreEntry.frequency > filters.minFrequency) {
        excludedByFrequency++
        continue
      }
    }

    if (filters.jlptMax !== null) {
      if (coreEntry?.jlpt === null || coreEntry?.jlpt === undefined || coreEntry.jlpt < filters.jlptMax) {
        excludedByJlpt++
        continue
      }
    }

    if (matchesExcludePattern(filters.excludePattern, key)) {
      excludedByRegex++
      continue
    }

    eligible.push(key)
  }

  eligible.sort((left, right) => compareMissingKeys(left, right, coreEntries))

  const start = Math.min(offset, eligible.length)
  const end = limit === null ? eligible.length : Math.min(start + limit, eligible.length)

  return {
    totalMissing,
    eligibleMissing: eligible.length,
    pagedMissing: end - start,
    excludedByCommon,
    excludedByFrequency,
    excludedByJlpt,
    excludedByRegex,
    keys: eligible.slice(start, end),
  }
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
    'You are a multilingual dictionary editor.',
    `Target language: ${LANG_NAME[lang]}.`,
    `Input source definition language: ${sourceLabel}.`,
    STYLE_HINT[lang],
    'Generate concise dictionary-style glosses.',
    'Output strict JSON only in this shape:',
    '{"items":[{"id":"<id>","definitions":["..."]}]}',
    'Rules:',
    '- Keep each "id" exactly as provided.',
    '- Definitions must be short phrases, not full sentences.',
    '- Do not add numbering, markdown, explanations, or comments.',
    `- Provide 1 to ${maxDefs} definitions when possible; return [] if unknown.`,
    '- Do not include duplicate definitions within the same id.',
    '',
    'Items:',
    JSON.stringify(items),
  ].join('\n')
}

function getNumberField(record: Record<string, unknown>, camel: string, snake: string): number {
  const value = record[camel] ?? record[snake]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function parseUsageMetadata(value: unknown): UsageStats {
  if (!value || typeof value !== 'object') {
    return { promptTokens: 0, candidateTokens: 0, thoughtsTokens: 0, totalTokens: 0 }
  }

  const record = value as Record<string, unknown>
  return {
    promptTokens: getNumberField(record, 'promptTokenCount', 'prompt_token_count'),
    candidateTokens: getNumberField(record, 'candidatesTokenCount', 'candidates_token_count'),
    thoughtsTokens: getNumberField(record, 'thoughtsTokenCount', 'thoughts_token_count'),
    totalTokens: getNumberField(record, 'totalTokenCount', 'total_token_count'),
  }
}

function getResponseText(response: unknown): string {
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
  }
  return ''
}

async function callGemini(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  temperature: number,
  retries: number
): Promise<GenerateResult> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature,
          responseMimeType: 'application/json',
        },
      })
      const text = getResponseText(response).trim()

      if (!text) {
        throw new Error('Gemini returned no text content')
      }

      const usageContainer = response as unknown as { usageMetadata?: unknown; usage_metadata?: unknown }
      return {
        text,
        usage: parseUsageMetadata(usageContainer.usageMetadata ?? usageContainer.usage_metadata),
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= retries) break
      const backoff = Math.min(15000, 500 * 2 ** (attempt - 1))
      await sleep(backoff)
    }
  }

  throw lastError ?? new Error('Gemini request failed')
}

async function countPromptTokens(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  retries: number
): Promise<number> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.models.countTokens({
        model,
        contents: prompt,
      })
      const container = response as unknown as { totalTokens?: unknown; total_tokens?: unknown }
      const totalTokens = container.totalTokens ?? container.total_tokens
      if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
        throw new Error('Gemini countTokens returned an invalid token count')
      }
      return totalTokens
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= retries) break
      const backoff = Math.min(15000, 500 * 2 ** (attempt - 1))
      await sleep(backoff)
    }
  }

  throw lastError ?? new Error('Gemini countTokens request failed')
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

export function resolvePricing(opts: CliOptions): PricingConfig | null {
  const normalizedModel = normalizeModelName(opts.model)
  const preset = MODEL_PRICING[normalizedModel] ?? null

  const inputUsdPerMillion = opts.inputPricePer1M ?? preset?.inputUsdPerMillion ?? null
  const outputUsdPerMillion = opts.outputPricePer1M ?? preset?.outputUsdPerMillion ?? null

  if (inputUsdPerMillion === null || outputUsdPerMillion === null) {
    return null
  }

  return { inputUsdPerMillion, outputUsdPerMillion }
}

function estimateBatchOutputTokens(batchSize: number, opts: CliOptions, totals: RunTotals): number {
  if (totals.generatedEntries > 0 && totals.candidateTokens > 0) {
    const averagePerEntry = totals.candidateTokens / totals.generatedEntries
    return Math.max(1, Math.ceil(averagePerEntry * batchSize))
  }

  return Math.max(120, batchSize * (opts.maxDefs * 6 + 3))
}

function estimateUsageCost(usage: UsageStats, pricing: PricingConfig | null): number {
  if (!pricing) return 0
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputUsdPerMillion
  const outputCost = (usage.candidateTokens / 1_000_000) * pricing.outputUsdPerMillion
  return inputCost + outputCost
}

function makeEmptyTotals(): RunTotals {
  return {
    promptTokens: 0,
    candidateTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    countRequests: 0,
    generateRequests: 0,
    generatedEntries: 0,
  }
}

function mergeUsageIntoTotals(totals: RunTotals, usage: UsageStats, pricing: PricingConfig | null): void {
  totals.promptTokens += usage.promptTokens
  totals.candidateTokens += usage.candidateTokens
  totals.thoughtsTokens += usage.thoughtsTokens
  totals.totalTokens += usage.totalTokens
  totals.estimatedCostUsd += estimateUsageCost(usage, pricing)
}

function roundCurrency(value: number): string {
  return value.toFixed(4)
}

async function writeReport(path: string, report: RunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(report, null, 2))
}

async function processLanguage(
  lang: TargetLang,
  opts: CliOptions,
  masterKeys: string[],
  seedFile: LangFile | null,
  target: LangFile,
  coreEntries: Record<string, CoreEntry>,
  filters: SelectionFilters,
  pricing: PricingConfig | null,
  client: GoogleGenAI | null,
  globalTotals: RunTotals,
  updatesDb: Database | null,
  updateBatchId: number | null
): Promise<LanguageReport> {
  const langPath = `${LANG_DIR}/${lang}.json`
  const selection = collectMissingKeys(masterKeys, target, coreEntries, filters, opts.offset, opts.limit)

  console.log(`\n=== ${lang} ===`)
  console.log(`Missing entries total: ${selection.totalMissing.toLocaleString()}`)
  console.log(`Eligible after filters: ${selection.eligibleMissing.toLocaleString()}`)
  console.log(`Selected after offset/limit: ${selection.pagedMissing.toLocaleString()}`)
  if (selection.excludedByCommon > 0) {
    console.log(`Excluded by common filter: ${selection.excludedByCommon.toLocaleString()}`)
  }
  if (selection.excludedByFrequency > 0) {
    console.log(`Excluded by frequency filter: ${selection.excludedByFrequency.toLocaleString()}`)
  }
  if (selection.excludedByJlpt > 0) {
    console.log(`Excluded by JLPT filter: ${selection.excludedByJlpt.toLocaleString()}`)
  }
  if (selection.excludedByRegex > 0) {
    console.log(`Excluded by regex filter: ${selection.excludedByRegex.toLocaleString()}`)
  }

  if (selection.keys.length === 0) {
    console.log('Nothing to fill.')
    return {
      lang,
      totalMissing: selection.totalMissing,
      eligibleMissing: selection.eligibleMissing,
      pagedMissing: selection.pagedMissing,
      excludedByCommon: selection.excludedByCommon,
      excludedByFrequency: selection.excludedByFrequency,
      excludedByJlpt: selection.excludedByJlpt,
      excludedByRegex: selection.excludedByRegex,
      batches: 0,
      failedBatches: 0,
      updatedEntries: 0,
      addedDefinitions: 0,
      promptTokens: 0,
      candidateTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      stoppedReason: 'none',
    }
  }

  if (opts.dryRun) {
    const preview = selection.keys.slice(0, 5).map((k) => {
      const { word, reading } = parseKey(k)
      return `${word} [${reading}]`
    })
    console.log('Dry-run preview:')
    for (const row of preview) console.log(`  - ${row}`)
    return {
      lang,
      totalMissing: selection.totalMissing,
      eligibleMissing: selection.eligibleMissing,
      pagedMissing: selection.pagedMissing,
      excludedByCommon: selection.excludedByCommon,
      excludedByFrequency: selection.excludedByFrequency,
      excludedByJlpt: selection.excludedByJlpt,
      excludedByRegex: selection.excludedByRegex,
      batches: 0,
      failedBatches: 0,
      updatedEntries: 0,
      addedDefinitions: 0,
      promptTokens: 0,
      candidateTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      stoppedReason: 'none',
    }
  }

  if (!client) {
    throw new Error('Gemini SDK client is not initialized')
  }

  let batches = 0
  let failedBatches = 0
  let updatedEntries = 0
  let addedDefinitions = 0
  let hasUnsavedChanges = false
  let stoppedReason: LanguageReport['stoppedReason'] = 'none'

  const localTotals = makeEmptyTotals()

  for (let i = 0; i < selection.keys.length; i += opts.batchSize) {
    const batchKeys = selection.keys.slice(i, i + opts.batchSize)
    const items = buildPromptItems(batchKeys, lang, opts.seedLang, seedFile)
    const prompt = buildPrompt(lang, opts.seedLang, opts.maxDefs, items)
    const allowedIds = new Set(batchKeys)
    let promptTokens = 0
    batches++

    process.stdout.write(
      `\r  Batch ${batches.toLocaleString()} ` +
      `(${Math.min(i + opts.batchSize, selection.keys.length).toLocaleString()}/${selection.keys.length.toLocaleString()})`
    )

    try {
      const needsPreflightCount = opts.maxInputTokens !== null || opts.maxCostUsd !== null
      if (needsPreflightCount) {
        promptTokens = await countPromptTokens(client, opts.model, prompt, opts.retries)
        globalTotals.countRequests++
        localTotals.countRequests++
      }

      if (opts.maxInputTokens !== null && promptTokens > opts.maxInputTokens) {
        stoppedReason = 'max-input-tokens'
        console.log(
          `\n  Stopping before batch ${batches.toLocaleString()}: ` +
          `prompt uses ${promptTokens.toLocaleString()} input tokens, above --max-input-tokens=${opts.maxInputTokens.toLocaleString()}`
        )
        break
      }

      if (opts.maxCostUsd !== null) {
        if (!pricing) {
          throw new Error(
            `No pricing preset found for model "${opts.model}". ` +
            'Pass --input-price-per-1m and --output-price-per-1m to use --max-cost-usd.'
          )
        }

        const estimatedUsage: UsageStats = {
          promptTokens,
          candidateTokens: estimateBatchOutputTokens(batchKeys.length, opts, globalTotals),
          thoughtsTokens: 0,
          totalTokens: promptTokens + estimateBatchOutputTokens(batchKeys.length, opts, globalTotals),
        }
        const projectedCost = globalTotals.estimatedCostUsd + estimateUsageCost(estimatedUsage, pricing)

        if (projectedCost > opts.maxCostUsd) {
          stoppedReason = 'budget'
          console.log(
            `\n  Stopping before batch ${batches.toLocaleString()}: ` +
            `estimated spend would rise to $${roundCurrency(projectedCost)}, above --max-cost-usd=$${roundCurrency(opts.maxCostUsd)}`
          )
          break
        }
      }

      const raw = await callGemini(client, opts.model, prompt, opts.temperature, opts.retries)
      localTotals.generateRequests++
      globalTotals.generateRequests++
      localTotals.generatedEntries += batchKeys.length
      globalTotals.generatedEntries += batchKeys.length

      mergeUsageIntoTotals(localTotals, raw.usage, pricing)
      mergeUsageIntoTotals(globalTotals, raw.usage, pricing)

      const result = parseGeminiResult(raw.text, allowedIds, opts.maxDefs)

      for (const key of batchKeys) {
        const defs = result.get(key) ?? []
        if (defs.length === 0) continue

        if (opts.outputMode === 'updates-db') {
          if (!updatesDb || updateBatchId === null) {
            throw new Error('Updates DB is not initialized for updates-db output mode')
          }
          insertTranslationUpdate(updatesDb, {
            wordId: key,
            lang,
            definitions: defs,
            sources: ['ai'],
            sourceType: 'ai',
            batchId: updateBatchId,
            reviewStatus: 'pending',
          })
          updatedEntries++
          addedDefinitions += defs.length
        } else {
          const entry = ensureEntry(target, key)
          const before = entry.definitions.length

          for (const def of defs) {
            addLangDefinition(entry, def, 'ai')
          }

          const delta = entry.definitions.length - before
          if (delta > 0) {
            updatedEntries++
            addedDefinitions += delta
            hasUnsavedChanges = true
          }
        }
      }
    } catch (error) {
      failedBatches++
      const message = error instanceof Error ? error.message : String(error)
      console.log(`\n  Batch failed: ${message}`)
    }

    if (opts.minDelayMs > 0 && i + opts.batchSize < selection.keys.length) {
      await sleep(opts.minDelayMs)
    }

    if (opts.outputMode === 'json' && hasUnsavedChanges && batches % opts.saveEvery === 0) {
      await saveLang(langPath, target)
      hasUnsavedChanges = false
    }
  }

  console.log('')
  if (opts.outputMode === 'json' && hasUnsavedChanges) {
    await saveLang(langPath, target)
  }

  console.log(`Batches: ${batches.toLocaleString()} (failed: ${failedBatches.toLocaleString()})`)
  console.log(`Updated entries: ${updatedEntries.toLocaleString()}`)
  console.log(`Added definitions: ${addedDefinitions.toLocaleString()}`)
  if (localTotals.generateRequests > 0) {
    console.log(`Prompt tokens: ${localTotals.promptTokens.toLocaleString()}`)
    console.log(`Candidate tokens: ${localTotals.candidateTokens.toLocaleString()}`)
    if (pricing) {
      console.log(`Estimated spend: $${roundCurrency(localTotals.estimatedCostUsd)}`)
    }
  }
  if (opts.outputMode === 'updates-db' && updatedEntries > 0) {
    console.log(`Saved updates to: ${process.env.UPDATES_DATABASE_PATH || './updates.sqlite'}`)
  } else if (updatedEntries > 0) {
    console.log(`Saved: ${langPath}`)
  } else {
    console.log('No file changes written.')
  }

  return {
    lang,
    totalMissing: selection.totalMissing,
    eligibleMissing: selection.eligibleMissing,
    pagedMissing: selection.pagedMissing,
    excludedByCommon: selection.excludedByCommon,
    excludedByFrequency: selection.excludedByFrequency,
    excludedByJlpt: selection.excludedByJlpt,
    excludedByRegex: selection.excludedByRegex,
    batches,
    failedBatches,
    updatedEntries,
    addedDefinitions,
    promptTokens: localTotals.promptTokens,
    candidateTokens: localTotals.candidateTokens,
    thoughtsTokens: localTotals.thoughtsTokens,
    totalTokens: localTotals.totalTokens,
    estimatedCostUsd: localTotals.estimatedCostUsd,
    stoppedReason,
  }
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

export async function runGeminiImport(opts: GeminiRunOptions): Promise<{
  totals: RunTotals
  languages: LanguageReport[]
  reportFile: string | null
}> {
  const pricing = resolvePricing(opts)
  const filters = buildSelectionFilters(opts)
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null
  const client = !opts.dryRun
    ? new GoogleGenAI(apiKey ? { apiKey } : {})
    : null

  console.log('=== [AI] Gemini Definition Backfill ===')
  console.log(`Languages: ${opts.langs.join(', ')}`)
  console.log(`Seed language: ${opts.seedLang}`)
  console.log(`Output mode: ${opts.outputMode}`)
  console.log(`Model: ${opts.model}`)
  console.log(`Batch size: ${opts.batchSize}`)
  console.log(`Max definitions per entry: ${opts.maxDefs}`)
  console.log(`Offset: ${opts.offset.toLocaleString()}`)
  console.log(`Limit: ${opts.limit === null ? 'none' : opts.limit.toLocaleString()}`)
  console.log(`Common only: ${opts.commonOnly ? 'yes' : 'no'}`)
  console.log(`Min frequency: ${opts.minFrequency ?? 'none'}`)
  console.log(`JLPT max: ${opts.jlptMax ?? 'none'}`)
  console.log(`Exclude regex: ${opts.excludeRegex ?? 'none'}`)
  console.log(`Max input tokens: ${opts.maxInputTokens ?? 'none'}`)
  console.log(`Max cost USD: ${opts.maxCostUsd ?? 'none'}`)
  if (pricing) {
    console.log(
      `Pricing: input $${pricing.inputUsdPerMillion}/1M, output $${pricing.outputUsdPerMillion}/1M`
    )
  } else if (opts.maxCostUsd !== null) {
    console.log('Pricing: unavailable for this model without overrides')
  }
  console.log(`Dry run: ${opts.dryRun ? 'yes' : 'no'}`)

  if (!opts.dryRun && !apiKey) {
    throw new Error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) before running this script')
  }

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  let masterKeys: string[] = []
  let coreEntries: Record<string, CoreEntry> = {}
  let seedFile: LangFile | null = null
  const targetViews = new Map<TargetLang, LangFile>()
  let updatesDb: Database | null = null
  let updateBatchId: number | null = null

  try {
    if (opts.outputMode === 'updates-db') {
      const activeRelease = requireActiveReleaseConfig()
      const releaseDb = new Database(activeRelease.dbPath, { readonly: true })
      updatesDb = initUpdatesDatabase()

      const releaseSnapshot = loadSnapshotFromReleaseDb(releaseDb)
      const effectiveSnapshot = applyActiveUpdatesToSnapshot(releaseSnapshot, updatesDb)

      masterKeys = Array.from(releaseSnapshot.words.keys())
      coreEntries = buildCoreEntriesFromSnapshot(releaseSnapshot)
      seedFile = opts.seedLang === 'none'
        ? null
        : buildLangViewFromSnapshot(effectiveSnapshot, opts.seedLang)

      for (const lang of opts.langs) {
        targetViews.set(lang, buildLangViewFromSnapshot(effectiveSnapshot, lang))
      }

      if (!opts.dryRun) {
        updateBatchId = insertUpdateBatch(updatesDb, {
          kind: 'ai_import',
          inputManifest: {
            langs: opts.langs,
            seedLang: opts.seedLang,
            model: opts.model,
            outputMode: opts.outputMode,
          },
          notes: 'Gemini glossary backfill',
          actor: opts.actor ?? null,
        })
      }

      releaseDb.close()
    } else {
      const masterPath = `${LANG_DIR}/en.json`
      if (!existsSync(masterPath)) {
        throw new Error(`Master language file not found: ${masterPath}`)
      }
      if (!existsSync(CORE_PATH)) {
        throw new Error(`Core metadata file not found: ${CORE_PATH}`)
      }

      console.log('Loading master key list: en')
      const masterFile = await loadLang(masterPath, 'en')
      masterKeys = Object.keys(masterFile.entries)
      const core = await loadCore(CORE_PATH)
      coreEntries = core.entries
      seedFile = opts.seedLang === 'en'
        ? masterFile
        : await loadSeedFile(opts.seedLang)

      for (const lang of opts.langs) {
        targetViews.set(lang, await loadLang(`${LANG_DIR}/${lang}.json`, lang))
      }
    }

    console.log(`Master key count: ${masterKeys.length.toLocaleString()}`)

    const totals = makeEmptyTotals()
    const languages: LanguageReport[] = []

    for (const lang of opts.langs) {
      const report = await processLanguage(
        lang,
        opts,
        masterKeys,
        seedFile,
        targetViews.get(lang) ?? {
          version: '2.0.0',
          lang,
          updatedAt: new Date().toISOString(),
          stats: { entries: 0, withExamples: 0, sources: {} },
          entries: {},
        },
        coreEntries,
        filters,
        pricing,
        client,
        totals,
        updatesDb,
        updateBatchId
      )
      languages.push(report)

      if (report.stoppedReason === 'budget') {
        console.log('\nGlobal budget limit reached; skipping remaining languages.')
        break
      }

      if (report.stoppedReason === 'max-input-tokens') {
        console.log('\nStopped due to --max-input-tokens; adjust batch size or token cap to continue.')
        break
      }
    }

    if (opts.reportFile) {
      const report: RunReport = {
        generatedAt: new Date().toISOString(),
        model: opts.model,
        dryRun: opts.dryRun,
        pricing,
        options: {
          langs: opts.langs,
          seedLang: opts.seedLang,
          outputMode: opts.outputMode,
          batchSize: opts.batchSize,
          maxDefs: opts.maxDefs,
          saveEvery: opts.saveEvery,
          limit: opts.limit,
          offset: opts.offset,
          retries: opts.retries,
          minDelayMs: opts.minDelayMs,
          temperature: opts.temperature,
          commonOnly: opts.commonOnly,
          minFrequency: opts.minFrequency,
          jlptMax: opts.jlptMax,
          excludeRegex: opts.excludeRegex,
          maxInputTokens: opts.maxInputTokens,
          maxCostUsd: opts.maxCostUsd,
          reportFile: opts.reportFile,
        },
        totals,
        languages,
      }
      await writeReport(opts.reportFile, report)
      console.log(`Report written: ${opts.reportFile}`)
    }

    if (updatesDb && updateBatchId !== null) {
      finalizeUpdateBatch(updatesDb, updateBatchId, 'succeeded')
    }

    console.log('\n=== Done ===')
    return {
      totals,
      languages,
      reportFile: opts.reportFile,
    }
  } catch (error) {
    if (updatesDb && updateBatchId !== null) {
      const message = error instanceof Error ? error.message : String(error)
      finalizeUpdateBatch(updatesDb, updateBatchId, 'failed', message)
    }
    throw error
  } finally {
    updatesDb?.close()
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runGeminiImport(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Import failed:', error)
    process.exit(1)
  })
}
