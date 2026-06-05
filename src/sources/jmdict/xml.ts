import type { JmdictFile, JmdictGloss, JmdictKana, JmdictKanji, JmdictSense, JmdictWord } from './convert'

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&([a-zA-Z0-9_-]+);/g, '$1')
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)(?:xml:)?${name}="([^"]*)"`))
  return match ? decodeXml(match[1]) : undefined
}

function firstText(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`))
  return match ? decodeXml(match[1].trim()) : undefined
}

function elementBlocks(xml: string, tagName: string): Array<{ openTag: string; content: string }> {
  const results: Array<{ openTag: string; content: string }> = []
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    results.push({ openTag: match[1], content: match[2] })
  }
  return results
}

function texts(xml: string, tagName: string): string[] {
  return elementBlocks(xml, tagName)
    .map((block) => decodeXml(block.content.trim()))
    .filter(Boolean)
}

function entryBlocks(xml: string): string[] {
  return elementBlocks(xml, 'entry').map((block) => block.content)
}

function hasEmptyElement(xml: string, tagName: string): boolean {
  return new RegExp(`<${tagName}\\s*/>`).test(xml)
}

function parseKanji(entryXml: string): JmdictKanji[] {
  return elementBlocks(entryXml, 'k_ele').map((block) => {
    const priority = texts(block.content, 'ke_pri')
    return {
      text: firstText(block.content, 'keb') ?? '',
      common: priority.length > 0,
      tags: texts(block.content, 'ke_inf'),
      priority,
    }
  }).filter((kanji) => kanji.text)
}

function parseKana(entryXml: string): JmdictKana[] {
  return elementBlocks(entryXml, 'r_ele').map((block) => {
    const priority = texts(block.content, 're_pri')
    const restrictions = texts(block.content, 're_restr')
    return {
      text: firstText(block.content, 'reb') ?? '',
      common: priority.length > 0,
      tags: [
        ...texts(block.content, 're_inf'),
        ...(hasEmptyElement(block.content, 're_nokanji') ? ['no kanji'] : []),
      ],
      priority,
      appliesToKanji: restrictions.length > 0 ? restrictions : 'all',
    }
  }).filter((kana) => kana.text)
}

function parseGlosses(senseXml: string): JmdictGloss[] {
  return elementBlocks(senseXml, 'gloss').map((block) => ({
    lang: attr(block.openTag, 'lang') ?? 'eng',
    text: decodeXml(block.content.trim()),
  })).filter((gloss) => gloss.text)
}

function parseSenses(entryXml: string): JmdictSense[] {
  return elementBlocks(entryXml, 'sense').map((block) => {
    const appliesToKanji = texts(block.content, 'stagk')
    const appliesToKana = texts(block.content, 'stagr')
    return {
      partOfSpeech: texts(block.content, 'pos'),
      appliesToKanji: appliesToKanji.length > 0 ? appliesToKanji : 'all',
      appliesToKana: appliesToKana.length > 0 ? appliesToKana : 'all',
      field: texts(block.content, 'field'),
      misc: texts(block.content, 'misc'),
      dialect: texts(block.content, 'dial'),
      gloss: parseGlosses(block.content),
    }
  })
}

export function parseJmdictXml(xml: string): JmdictFile {
  const words: JmdictWord[] = entryBlocks(xml).map((entryXml) => ({
    id: firstText(entryXml, 'ent_seq') ?? '',
    kanji: parseKanji(entryXml),
    kana: parseKana(entryXml),
    sense: parseSenses(entryXml),
  })).filter((word) => word.id && word.kana.length > 0)

  return { words }
}
