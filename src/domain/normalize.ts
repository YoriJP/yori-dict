import type { ScriptType } from './types'

export function normalizeJapaneseText(value: string): string {
  return value.normalize('NFKC').trim()
}

export function katakanaToHiragana(value: string): string {
  return value.replace(/[\u30A1-\u30F6]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0x60)
  })
}

export function normalizeKana(value: string): string {
  return katakanaToHiragana(normalizeJapaneseText(value))
}

export function detectJapaneseScript(value: string): ScriptType {
  const text = normalizeJapaneseText(value)
  const hasKanji = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヶ]/.test(text)
  const hasHiragana = /[\u3040-\u309F]/.test(text)
  const hasKatakana = /[\u30A0-\u30FF]/.test(text)

  if (hasKanji && !hasHiragana && !hasKatakana) return 'kanji'
  if (!hasKanji && hasHiragana && !hasKatakana) return 'kana'
  if (!hasKanji && !hasHiragana && hasKatakana) return 'katakana'
  return 'mixed'
}
