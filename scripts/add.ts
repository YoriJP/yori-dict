/**
 * Add or enrich a manual dictionary entry (v2 schema).
 *
 * Usage:
 *   bun run add --lang en --word "新語" --reading "しんご" --def "neologism"
 *   bun run add --lang en --word "食べる" --reading "たべる" --def "to consume" --example "食べましょう|Let's eat"
 */

import { mkdir } from 'fs/promises'
import { createManualWordInSnapshot } from '../src/manual-word-service'
import type { Language } from '../src/types'

const DATA_DIR = './data'
const LANG_DIR = './data/lang'

interface AddOptions {
  lang: string
  word: string
  reading: string
  def?: string[]
  pos?: string[]
  jlpt?: number
  common?: boolean
  example?: string // format: "japanese|translation"
}

const SUPPORTED_LANGS = new Set(['en', 'de', 'ko', 'zh-cn', 'zh-tw'])

function parseArgs(): AddOptions | null {
  const args = process.argv.slice(2)
  const opts: Partial<AddOptions> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case '--lang':
        opts.lang = next
        i++
        break
      case '--word':
        opts.word = next
        i++
        break
      case '--reading':
        opts.reading = next
        i++
        break
      case '--def':
        opts.def = [...(opts.def ?? []), next]
        i++
        break
      case '--pos':
        opts.pos = [...(opts.pos ?? []), next]
        i++
        break
      case '--jlpt':
        opts.jlpt = parseInt(next, 10)
        i++
        break
      case '--common':
        opts.common = true
        break
      case '--example':
        opts.example = next
        i++
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  if (!opts.lang || !opts.word || !opts.reading) {
    console.error('Missing required arguments: --lang, --word, --reading')
    console.error('Run with --help for usage')
    return null
  }

  if (!SUPPORTED_LANGS.has(opts.lang)) {
    console.error(`Unsupported --lang: ${opts.lang}`)
    console.error('Supported languages: en, de, ko, zh-cn, zh-tw')
    return null
  }

  if (
    opts.jlpt !== undefined
    && (Number.isNaN(opts.jlpt) || opts.jlpt < 1 || opts.jlpt > 5)
  ) {
    console.error('--jlpt must be a number from 1 to 5')
    return null
  }

  return opts as AddOptions
}

function parseExample(example: string | undefined): { ja: string; text: string } | null {
  if (!example) return null
  const [ja, text] = example.split('|')
  if (!ja || !text) return null
  const jaTrimmed = ja.trim()
  const textTrimmed = text.trim()
  if (!jaTrimmed || !textTrimmed) return null
  return { ja: jaTrimmed, text: textTrimmed }
}

function printHelp(): void {
  console.log(`
Add Manual Dictionary Entry

Usage:
  bun run add --lang <lang> --word <word> --reading <reading> [options]

Required:
  --lang      Language code (en, de, ko, zh-cn, zh-tw)
  --word      Japanese word (kanji or kana)
  --reading   Hiragana reading

Optional:
  --def       Definition text (can use multiple times)
  --pos       Part of speech (can use multiple times)
  --jlpt      JLPT level (1-5)
  --common    Mark as common word
  --example   Example sentence (format: "japanese|translation")

Examples:
  bun run add --lang en --word "新語" --reading "しんご" --def "neologism" --pos "noun"
  bun run add --lang en --word "食べる" --reading "たべる" --def "to consume food"
  bun run add --lang en --word "走る" --reading "はしる" --def "to run" --example "毎朝走ります|I run every morning"
`)
}

async function main(): Promise<void> {
  const opts = parseArgs()
  if (!opts) process.exit(1)

  console.log('=== Add Manual Entry ===\n')

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(LANG_DIR, { recursive: true })

  const example = parseExample(opts.example)
  const result = await createManualWordInSnapshot({
    word: opts.word,
    reading: opts.reading,
    partOfSpeech: opts.pos,
    common: opts.common,
    jlpt: opts.jlpt ?? null,
    translations: [{
      lang: opts.lang as Language,
      definitions: opts.def ?? [],
      examples: example ? [{ japanese: example.ja, translation: example.text }] : [],
    }],
  }, {
    allowExistingWordId: true,
    allowDefinitionlessTranslations: true,
  })

  if (!result.created) {
    console.error('Validation failed:')
    for (const [field, messages] of Object.entries(result.fieldErrors)) {
      console.error(`  ${field}: ${messages.join(' | ')}`)
    }
    process.exit(1)
  }

  console.log(`Key: ${result.wordId}`)
  console.log(`Core: ${result.coreCreated ? 'created' : 'updated'}`)
  if (result.warnings.length > 0) {
    console.log('Warnings:')
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }
  console.log('\nSaved:')
  for (const file of result.snapshotFiles) {
    console.log(`  - ${file}`)
  }
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
