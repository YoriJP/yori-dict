import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { CurationQueue, CurationQueueItem } from '../../src/domain/curation-queue'

interface CliOptions {
  queue: string
  out: string
  model: string
  promptVersion: string
  apiKeyEnv: string
  apiBase: string
  limit?: number
  overwrite: boolean
}

export interface AiSuggestionRecord {
  queueItemId: string
  text: string
}

interface GenerateSuggestionInput {
  item: CurationQueueItem
  model: string
  promptVersion: string
  apiKey: string
  apiBase: string
}

type GenerateSuggestion = (input: GenerateSuggestionInput) => Promise<AiSuggestionRecord>

const DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY'
const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com'

function printHelp(): void {
  console.log(`
AI curation suggestion generator

Generates AI gloss suggestions from a curation queue and writes JSONL records.
This does not write overlays and does not approve dictionary data.

Usage:
  bun run generate:ai-suggestions --queue <queue.json> --out <suggestions.jsonl> --model <model> --prompt-version <version>

Options:
  --queue <path>           Curation queue JSON.
  --out <path>             Output suggestion JSONL.
  --model <name>           Gemini model name.
  --prompt-version <name>  Prompt/version identifier stored with later AI overlays.
  --api-key-env <name>     Environment variable containing the API key (default: ${DEFAULT_API_KEY_ENV})
  --api-base <url>         Gemini API base URL (default: ${DEFAULT_API_BASE})
  --limit <n>              Max queue items to generate.
  --overwrite              Replace an existing output file.
  --help, -h               Show this help.

Output JSONL shape:
  { "queueItemId": "missingGloss-yds_00000001-zh-tw", "text": "吃" }
`)
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function requireString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value
}

export function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    queue: '',
    out: '',
    model: '',
    promptVersion: '',
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    apiBase: DEFAULT_API_BASE,
    overwrite: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--queue' && next) {
      opts.queue = next
      i++
    } else if (arg === '--out' && next) {
      opts.out = next
      i++
    } else if (arg === '--model' && next) {
      opts.model = next
      i++
    } else if (arg === '--prompt-version' && next) {
      opts.promptVersion = next
      i++
    } else if (arg === '--api-key-env' && next) {
      opts.apiKeyEnv = next
      i++
    } else if (arg === '--api-base' && next) {
      opts.apiBase = next
      i++
    } else if (arg === '--limit' && next) {
      opts.limit = parsePositiveInt(next, '--limit')
      i++
    } else if (arg === '--overwrite') {
      opts.overwrite = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  requireString(opts.queue, '--queue')
  requireString(opts.out, '--out')
  requireString(opts.model, '--model')
  requireString(opts.promptVersion, '--prompt-version')
  requireString(opts.apiKeyEnv, '--api-key-env')
  requireString(opts.apiBase, '--api-base')
  return opts
}

function assertQueue(value: unknown): CurationQueue {
  const queue = value as CurationQueue
  if (!queue || queue.schemaVersion !== '1.0.0' || !Array.isArray(queue.items)) {
    throw new Error('Curation queue is invalid')
  }
  return queue
}

function buildPrompt(item: CurationQueueItem, promptVersion: string): string {
  if (item.type !== 'missingGloss') throw new Error(`Unsupported queue item type: ${item.type}`)

  const sourceGlosses = item.sourceGlosses
    .map((gloss) => `- ${gloss.lang}: ${gloss.text}`)
    .join('\n')

  return [
    `Prompt version: ${promptVersion}`,
    'Create one concise dictionary gloss for a Japanese dictionary website.',
    `Target language: ${item.targetLang}`,
    `Japanese headword: ${item.primaryForm}`,
    `Reading: ${item.primaryReading}`,
    `Part of speech: ${item.partOfSpeech.join(', ') || 'unknown'}`,
    'Source glosses:',
    sourceGlosses || '- none',
    '',
    'Return only JSON in this exact shape:',
    '{"text":"<target-language gloss>"}',
  ].join('\n')
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return match ? match[1].trim() : trimmed
}

export function parseModelSuggestion(text: string): string {
  const raw = stripJsonFence(text)
  const parsed = JSON.parse(raw) as { text?: unknown }
  if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
    throw new Error('Model response must contain a non-empty text field')
  }
  return parsed.text.trim()
}

function geminiModelPath(model: string): string {
  const path = model.startsWith('models/') ? model : `models/${model}`
  return path.split('/').map(encodeURIComponent).join('/')
}

function extractGeminiText(value: unknown): string {
  const response = value as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: unknown }>
      }
    }>
  }
  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => typeof part.text === 'string' ? part.text : '')
    .join('')
    .trim()

  if (!text) throw new Error('Gemini response did not include text')
  return text
}

export async function generateGeminiGlossSuggestion(input: GenerateSuggestionInput): Promise<AiSuggestionRecord> {
  const url = `${input.apiBase.replace(/\/+$/, '')}/v1beta/${geminiModelPath(input.model)}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': input.apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: buildPrompt(input.item, input.promptVersion) }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`)
  }

  const text = extractGeminiText(await response.json())
  return {
    queueItemId: input.item.id,
    text: parseModelSuggestion(text),
  }
}

async function loadQueue(path: string): Promise<CurationQueue> {
  return assertQueue(await Bun.file(path).json())
}

async function writeSuggestions(path: string, suggestions: AiSuggestionRecord[], overwrite: boolean): Promise<void> {
  if (existsSync(path) && !overwrite) throw new Error(`Output already exists: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  const body = suggestions.map((suggestion) => JSON.stringify(suggestion)).join('\n')
  await Bun.write(path, body ? `${body}\n` : '')
}

export async function runGenerateAiCurationSuggestions(
  opts: CliOptions,
  generateSuggestion: GenerateSuggestion = generateGeminiGlossSuggestion
): Promise<AiSuggestionRecord[]> {
  const apiKey = process.env[opts.apiKeyEnv]
  if (!apiKey?.trim()) throw new Error(`${opts.apiKeyEnv} is required`)

  const queue = await loadQueue(opts.queue)
  const items = typeof opts.limit === 'number' ? queue.items.slice(0, opts.limit) : queue.items
  if (items.length === 0) throw new Error('Curation queue has no items to generate')
  if (existsSync(opts.out) && !opts.overwrite) throw new Error(`Output already exists: ${opts.out}`)

  const suggestions: AiSuggestionRecord[] = []
  for (const item of items) {
    suggestions.push(await generateSuggestion({
      item,
      model: opts.model,
      promptVersion: opts.promptVersion,
      apiKey,
      apiBase: opts.apiBase,
    }))
  }

  await writeSuggestions(opts.out, suggestions, opts.overwrite)

  console.log('\n=== AI Curation Suggestions ===')
  console.log(`Queue: ${opts.queue}`)
  console.log(`Output: ${opts.out}`)
  console.log(`Model: ${opts.model}`)
  console.log(`Prompt version: ${opts.promptVersion}`)
  console.log(`Suggestions: ${suggestions.length.toLocaleString()}`)
  for (const suggestion of suggestions.slice(0, 10)) {
    console.log(`  - ${suggestion.queueItemId}\t${suggestion.text}`)
  }

  return suggestions
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  await runGenerateAiCurationSuggestions(opts)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
