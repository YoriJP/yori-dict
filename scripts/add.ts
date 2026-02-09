/**
 * Add manual dictionary entry
 *
 * Usage:
 *   bun run add --lang en --word "新語" --reading "しんご" --def "neologism"
 *   bun run add --lang en --word "食べる" --reading "たべる" --def "to consume" --example "食べましょう|Let's eat"
 */

import { mkdir } from 'fs/promises'
import {
  type DictEntry,
  type DictFile,
  makeKey,
  loadDict,
  saveDict,
  mergeEntries,
} from './import/base'

const DATA_DIR = './data'

interface AddOptions {
  lang: string
  word: string
  reading: string
  def?: string[]
  pos?: string[]
  jlpt?: number
  common?: boolean
  example?: string // Format: "japanese|translation"
}

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
        return null
    }
  }

  // Validate required fields
  if (!opts.lang || !opts.word || !opts.reading) {
    console.error('Missing required arguments: --lang, --word, --reading')
    console.error('Run with --help for usage')
    return null
  }

  return opts as AddOptions
}

function printHelp(): void {
  console.log(`
Add Manual Dictionary Entry

Usage:
  bun run add --lang <lang> --word <word> --reading <reading> [options]

Required:
  --lang      Language code (en, de, zh-TW, etc.)
  --word      Japanese word (kanji or kana)
  --reading   Hiragana reading

Optional:
  --def       Definition text (can use multiple times)
  --pos       Part of speech (can use multiple times)
  --jlpt      JLPT level (1-5)
  --common    Mark as common word
  --example   Example sentence (format: "japanese|translation")

Examples:
  # Add new word with definition
  bun run add --lang en --word "新語" --reading "しんご" --def "neologism" --pos "noun"

  # Add definition to existing word
  bun run add --lang en --word "食べる" --reading "たべる" --def "to consume food"

  # Add with example
  bun run add --lang en --word "走る" --reading "はしる" --def "to run" \\
    --example "毎朝走ります|I run every morning"
`)
}

async function main(): Promise<void> {
  const opts = parseArgs()
  if (!opts) {
    process.exit(1)
  }

  console.log('=== Add Manual Entry ===\n')

  // Load dictionary
  await mkdir(DATA_DIR, { recursive: true })
  const dictPath = `${DATA_DIR}/${opts.lang}.json`
  const dict = await loadDict(dictPath, opts.lang)

  // Create entry
  const key = makeKey(opts.word, opts.reading)
  const newEntry: DictEntry = {
    word: opts.word,
    reading: opts.reading,
    partOfSpeech: opts.pos ?? [],
    common: opts.common || false,
    jlpt: opts.jlpt ? [opts.jlpt] : [],
    definitions: opts.def
      ? opts.def.map((text) => ({ text, sources: ['manual'] }))
      : [],
    examples: [],
  }

  // Parse example if provided
  if (opts.example) {
    const [ja, text] = opts.example.split('|')
    if (ja && text) {
      newEntry.examples.push({ ja, text, sources: ['manual'] })
    }
  }

  // Check if entry exists
  const existing = dict.entries[key]

  if (existing) {
    console.log(`Entry exists: ${key}`)
    console.log(`  Current definitions: ${existing.definitions.length}`)

    // Merge entries
    dict.entries[key] = mergeEntries(existing, newEntry)

    console.log(`  After merge: ${dict.entries[key].definitions.length}`)
    console.log('\nMerged with existing entry.')
  } else {
    dict.entries[key] = newEntry
    console.log(`Added new entry: ${key}`)
  }

  // Save
  await saveDict(dictPath, dict)

  // Print result
  const entry = dict.entries[key]
  console.log('\nEntry:')
  console.log(`  Word: ${entry.word}`)
  console.log(`  Reading: ${entry.reading}`)
  console.log(`  POS: ${entry.partOfSpeech.join(', ') || '(none)'}`)
  console.log(`  Common: ${entry.common}`)
  console.log(`  JLPT: ${entry.jlpt.length > 0 ? entry.jlpt.join(', ') : '(none)'}`)
  console.log(`  Definitions:`)
  for (const def of entry.definitions) {
    console.log(`    - "${def.text}" [${def.sources.join(', ')}]`)
  }
  if (entry.examples.length > 0) {
    console.log(`  Examples:`)
    for (const ex of entry.examples) {
      console.log(`    - ${ex.ja} → ${ex.text} [${ex.sources.join(', ')}]`)
    }
  }

  console.log(`\nSaved to: ${dictPath}`)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
