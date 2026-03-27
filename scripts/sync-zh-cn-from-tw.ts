/**
 * Sync Simplified Chinese (zh-cn) glosses from Traditional Chinese (zh-tw).
 *
 * For each entry in zh-tw with definitions or examples, converts
 * Traditional → Simplified via OpenCC and merges into zh-cn (source: zh-tw-opencc).
 *
 * Run after expanding zh-tw so zh-cn coverage tracks zh-tw without a second
 * Chinese LLM pass for variant conversion.
 *
 * Usage:
 *   bun run sync:zh-cn-from-tw              # preview only
 *   bun run sync:zh-cn-from-tw --apply      # write data/lang/zh-cn.json
 */

import * as OpenCC from 'opencc-js'
import {
  addLangDefinition,
  createEmptyLangEntry,
  loadLang,
  saveLang,
} from './import/base'

const ZH_CN_PATH = './data/lang/zh-cn.json'
const ZH_TW_PATH = './data/lang/zh-tw.json'

const SOURCE_TAG = 'zh-tw-opencc'

function parseArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes('--apply') }
}

function exampleKey(ja: string, text: string, source: string): string {
  return `${ja}\u0000${text}\u0000${source}`
}

function countNewStrings(before: Set<string>, after: string[]): number {
  let n = 0
  for (const s of after) {
    if (!before.has(s)) n++
  }
  return n
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2))

  const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }) as (text: string) => string

  const zhTw = await loadLang(ZH_TW_PATH, 'zh-tw')
  const zhCn = await loadLang(ZH_CN_PATH, 'zh-cn')

  let keysTouched = 0
  let newDefinitionStrings = 0
  let examplesAdded = 0

  for (const [key, twEntry] of Object.entries(zhTw.entries)) {
    if (twEntry.definitions.length === 0 && twEntry.examples.length === 0) continue

    let cnEntry = zhCn.entries[key]
    if (!cnEntry) {
      cnEntry = createEmptyLangEntry()
      zhCn.entries[key] = cnEntry
    }

    const defsBefore = new Set(cnEntry.definitions)
    const exBefore = cnEntry.examples.length

    for (const def of twEntry.definitions) {
      addLangDefinition(cnEntry, toSimplified(def), SOURCE_TAG)
    }

    const seen = new Set(cnEntry.examples.map((e) => exampleKey(e.ja, e.text, e.source)))
    for (const ex of twEntry.examples) {
      const textCn = toSimplified(ex.text)
      const k = exampleKey(ex.ja, textCn, ex.source)
      if (seen.has(k)) continue
      cnEntry.examples.push({ ja: ex.ja, text: textCn, source: ex.source })
      seen.add(k)
    }

    const dNew = countNewStrings(defsBefore, cnEntry.definitions)
    const eNew = cnEntry.examples.length - exBefore
    if (dNew > 0 || eNew > 0) {
      keysTouched++
      newDefinitionStrings += dNew
      examplesAdded += eNew
    }
  }

  const withDef = Object.values(zhCn.entries).filter((e) => e.definitions.length > 0).length

  console.log('=== Sync zh-cn from zh-tw (OpenCC tw → cn) ===\n')
  console.log(`  Entries with merged updates: ${keysTouched.toLocaleString()}`)
  console.log(`  New definition strings added to zh-cn: ${newDefinitionStrings.toLocaleString()}`)
  console.log(`  New example rows added to zh-cn: ${examplesAdded.toLocaleString()}`)
  console.log(`  zh-cn entries with ≥1 definition (after): ${withDef.toLocaleString()}`)

  if (!apply) {
    console.log('\n  Preview only. Run with --apply to write zh-cn.json.')
    return
  }

  await saveLang(ZH_CN_PATH, zhCn)
  console.log(`\n  Saved: ${ZH_CN_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
