import { existsSync } from 'fs'
import { sanitizeDefinitionText } from './base'

export type YomitanEntry = [string, string, string, string, number, YomitanDef[], number, string]

export type YomitanDef =
  | string
  | { type: 'structured-content'; content: YomitanNode }

export type YomitanNode =
  | string
  | YomitanNode[]
  | { tag: string; content?: YomitanNode; lang?: string; [key: string]: unknown }

function normalizeWhitespace(text: string): string {
  return sanitizeDefinitionText(text)
    .replace(/\s+/g, ' ')
    .trim()
}

export function collectText(node: YomitanNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (node.content !== undefined) return collectText(node.content as YomitanNode)
  return ''
}

function collectLangTexts(node: YomitanNode, lang: string, results: string[]): void {
  if (typeof node === 'string') return
  if (Array.isArray(node)) {
    for (const child of node) collectLangTexts(child, lang, results)
    return
  }

  if (node.lang === lang) {
    const text = typeof node.content === 'string'
      ? node.content
      : collectText(node.content as YomitanNode)
    const cleaned = normalizeWhitespace(text)
    if (cleaned) results.push(cleaned)
  }

  if (node.content !== undefined && typeof node.content !== 'string') {
    collectLangTexts(node.content as YomitanNode, lang, results)
  }
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const value of values) {
    const normalized = value.toLowerCase().trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(value)
  }
  return deduped
}

export function extractDefinitionTexts(defs: YomitanDef[], maxDefinitions = 8): string[] {
  const collected: string[] = []

  for (const def of defs) {
    const rawText = typeof def === 'string' ? def : collectText(def.content)
    const cleaned = normalizeWhitespace(rawText)
      .replace(/\s*[\u2022\u30fb]\s*/g, '; ')
      .replace(/\s*;\s*/g, '; ')
      .trim()

    if (cleaned.length < 2) continue
    collected.push(cleaned)
    if (collected.length >= maxDefinitions) break
  }

  return dedupeCaseInsensitive(collected)
}

function isUsefulExampleText(text: string, word: string, reading: string): boolean {
  if (!text) return false
  if (text === word || text === reading) return false
  if (text.length < 2) return false
  return true
}

export function extractExamplePairs(
  defs: YomitanDef[],
  word: string,
  reading: string
): Array<{ ja: string; text: string }> {
  const examples: Array<{ ja: string; text: string }> = []
  const seen = new Set<string>()

  for (const def of defs) {
    if (typeof def === 'string') continue

    const jaTexts: string[] = []
    const enTexts: string[] = []
    collectLangTexts(def.content, 'ja', jaTexts)
    collectLangTexts(def.content, 'en', enTexts)

    const cleanedJa = dedupeCaseInsensitive(
      jaTexts.map(normalizeWhitespace).filter((text) => isUsefulExampleText(text, word, reading))
    )
    const cleanedEn = dedupeCaseInsensitive(
      enTexts.map(normalizeWhitespace).filter((text) => text.length >= 2)
    )

    const pairCount = Math.min(cleanedJa.length, cleanedEn.length)
    for (let i = 0; i < pairCount; i++) {
      const ex = { ja: cleanedJa[i], text: cleanedEn[i] }
      const key = `${ex.ja}\u0000${ex.text}`
      if (seen.has(key)) continue
      seen.add(key)
      examples.push(ex)
    }
  }

  return examples
}

export async function loadYomitanTermBanks(zipPath: string): Promise<YomitanEntry[]> {
  const file = Bun.file(zipPath)
  if (!(await file.exists())) {
    throw new Error(`ZIP not found: ${zipPath}`)
  }

  const extractDir = zipPath.replace(/\.zip$/, '')
  if (!existsSync(`${extractDir}/term_bank_1.json`)) {
    const proc = Bun.spawn(['unzip', '-o', zipPath, '-d', extractDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`Failed to extract ${zipPath}`)
    }
  }

  const entries: YomitanEntry[] = []
  for (let i = 1; ; i++) {
    const bankPath = `${extractDir}/term_bank_${i}.json`
    const bankFile = Bun.file(bankPath)
    if (!(await bankFile.exists())) break
    const bank = await bankFile.json() as YomitanEntry[]
    entries.push(...bank)
  }

  if (entries.length === 0) {
    throw new Error(`No term_bank_*.json found in ${extractDir}`)
  }

  return entries
}
