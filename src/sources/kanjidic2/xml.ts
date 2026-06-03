import type { Kanjidic2Character, Kanjidic2Meaning, Kanjidic2Reading } from './convert'

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return match ? decodeXml(match[1]) : undefined
}

function firstText(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`))
  return match ? decodeXml(match[1].trim()) : undefined
}

function numberText(xml: string, tagName: string): number | undefined {
  const text = firstText(xml, tagName)
  if (!text) return undefined
  const value = Number.parseInt(text, 10)
  return Number.isInteger(value) ? value : undefined
}

function elements(xml: string, tagName: string): Array<{ openTag: string; content: string }> {
  const results: Array<{ openTag: string; content: string }> = []
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    results.push({ openTag: match[1], content: decodeXml(match[2].trim()) })
  }
  return results
}

function characterBlocks(xml: string): string[] {
  const results: string[] = []
  const pattern = /<character>([\s\S]*?)<\/character>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    results.push(match[1])
  }
  return results
}

function parseCodepoint(characterXml: string): string | undefined {
  for (const item of elements(characterXml, 'cp_value')) {
    if (attr(item.openTag, 'cp_type') === 'ucs') return item.content.toLowerCase()
  }
  return undefined
}

function parseMeanings(characterXml: string): Kanjidic2Meaning[] {
  return elements(characterXml, 'meaning').map((meaning) => ({
    lang: attr(meaning.openTag, 'm_lang') ?? 'en',
    text: meaning.content,
  }))
}

function parseReadings(characterXml: string): Kanjidic2Reading[] {
  const readings = elements(characterXml, 'reading').map((reading) => ({
    type: attr(reading.openTag, 'r_type') ?? '',
    text: reading.content,
  }))
  const nanori = elements(characterXml, 'nanori').map((reading) => ({
    type: 'nanori',
    text: reading.content,
  }))
  return [...readings, ...nanori]
}

export function parseKanjidic2Xml(xml: string): Kanjidic2Character[] {
  return characterBlocks(xml).map((characterXml) => ({
    literal: firstText(characterXml, 'literal') ?? '',
    codepoint: parseCodepoint(characterXml),
    meanings: parseMeanings(characterXml),
    readings: parseReadings(characterXml),
    grade: numberText(characterXml, 'grade'),
    strokeCount: numberText(characterXml, 'stroke_count'),
    frequency: numberText(characterXml, 'freq'),
    jlpt: numberText(characterXml, 'jlpt'),
  }))
}
