/**
 * Add or enrich a manual dictionary entry (v2 schema).
 *
 * Usage:
 *   bun run add --lang en --word "新語" --reading "しんご" --def "neologism"
 *   bun run add --lang en --word "食べる" --reading "たべる" --def "to consume" --example "食べましょう|Let's eat"
 */

import { mkdir } from 'fs/promises'
import {
  addLangDefinition,
  createEmptyLangEntry,
  loadCore,
  loadLang,
  makeKey,
  saveCore,
  saveLang,
} from './import/base'

const DATA_DIR = './data'
const LANG_DIR = './data/lang'
const CORE_PATH = `${DATA_DIR}/core.json`

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

  const core = await loadCore(CORE_PATH)
  const langPath = `${LANG_DIR}/${opts.lang}.json`
  const lang = await loadLang(langPath, opts.lang)

  const key = makeKey(opts.word, opts.reading)
  const posToAdd = (opts.pos ?? []).map((p) => p.trim()).filter(Boolean)
  const example = parseExample(opts.example)

  const hadCoreEntry = Boolean(core.entries[key])
  if (!core.entries[key]) {
    core.entries[key] = {
      word: opts.word,
      reading: opts.reading,
      partOfSpeech: [...new Set(posToAdd)],
      common: Boolean(opts.common),
      jlpt: opts.jlpt ?? null,
      frequency: null,
    }
  } else {
    const coreEntry = core.entries[key]
    coreEntry.word = opts.word
    coreEntry.reading = opts.reading
    coreEntry.partOfSpeech = [...new Set([...coreEntry.partOfSpeech, ...posToAdd])]
    if (opts.common) coreEntry.common = true
    if (opts.jlpt !== undefined) {
      coreEntry.jlpt = coreEntry.jlpt === null ? opts.jlpt : Math.max(coreEntry.jlpt, opts.jlpt)
    }
  }

  if (!lang.entries[key]) {
    lang.entries[key] = createEmptyLangEntry()
  }

  const langEntry = lang.entries[key]
  const defsBefore = langEntry.definitions.length
  for (const def of opts.def ?? []) {
    addLangDefinition(langEntry, def, 'manual')
  }

  let exampleAdded = false
  if (example) {
    const exists = langEntry.examples.some(
      (ex) => ex.ja === example.ja && ex.text === example.text && ex.source === 'manual'
    )
    if (!exists) {
      langEntry.examples.push({ ...example, source: 'manual' })
      exampleAdded = true
    }
  }

  await saveCore(CORE_PATH, core)
  await saveLang(langPath, lang)

  const coreEntry = core.entries[key]
  console.log(`Key: ${key}`)
  console.log(`Core: ${hadCoreEntry ? 'updated' : 'created'}`)
  console.log(`Lang (${opts.lang}) definitions: ${defsBefore} -> ${langEntry.definitions.length}`)
  console.log(`Example added: ${exampleAdded ? 'yes' : 'no'}`)
  console.log(`POS: ${coreEntry.partOfSpeech.join(', ') || '(none)'}`)
  console.log(`Common: ${coreEntry.common}`)
  console.log(`JLPT: ${coreEntry.jlpt !== null ? `N${coreEntry.jlpt}` : '(none)'}`)
  console.log('\nSaved:')
  console.log(`  - ${CORE_PATH}`)
  console.log(`  - ${langPath}`)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
