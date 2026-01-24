import type { Conjugations, VerbType } from './types'

// Godan verb stem endings and their conjugations
const GODAN_ENDINGS: Record<string, { i: string; a: string; e: string; o: string; te: string; ta: string }> = {
  'う': { i: 'い', a: 'わ', e: 'え', o: 'お', te: 'って', ta: 'った' },
  'く': { i: 'き', a: 'か', e: 'け', o: 'こ', te: 'いて', ta: 'いた' },
  'ぐ': { i: 'ぎ', a: 'が', e: 'げ', o: 'ご', te: 'いで', ta: 'いだ' },
  'す': { i: 'し', a: 'さ', e: 'せ', o: 'そ', te: 'して', ta: 'した' },
  'つ': { i: 'ち', a: 'た', e: 'て', o: 'と', te: 'って', ta: 'った' },
  'ぬ': { i: 'に', a: 'な', e: 'ね', o: 'の', te: 'んで', ta: 'んだ' },
  'ぶ': { i: 'び', a: 'ば', e: 'べ', o: 'ぼ', te: 'んで', ta: 'んだ' },
  'む': { i: 'み', a: 'ま', e: 'め', o: 'も', te: 'んで', ta: 'んだ' },
  'る': { i: 'り', a: 'ら', e: 'れ', o: 'ろ', te: 'って', ta: 'った' },
}

// Special case: 行く
const IKU_CONJUGATIONS = {
  te: 'いって',
  ta: 'いった',
}

/**
 * Detect verb type from part of speech tags
 */
export function detectVerbType(partOfSpeech: string[]): VerbType {
  const posStr = partOfSpeech.join(' ').toLowerCase()

  // Check for i-adjective
  if (posStr.includes('i-adjective') || posStr.includes('adjective-i')) {
    return 'i-adjective'
  }

  // Check for ichidan (一段) verb
  if (posStr.includes('ichidan') || posStr.includes('一段')) {
    return 'ichidan'
  }

  // Check for godan (五段) verb
  if (posStr.includes('godan') || posStr.includes('五段')) {
    return 'godan'
  }

  // Check for suru verb
  if (posStr.includes('suru') || posStr.includes('する')) {
    return 'suru'
  }

  // Check for kuru verb
  if (posStr.includes('kuru') || posStr.includes('来る')) {
    return 'kuru'
  }

  return null
}

/**
 * Conjugate an ichidan (一段) verb
 */
function conjugateIchidan(reading: string): Conjugations {
  const stem = reading.slice(0, -1) // Remove る

  return {
    dictionary: reading,
    polite: stem + 'ます',
    negative: stem + 'ない',
    past: stem + 'た',
    te: stem + 'て',
  }
}

/**
 * Conjugate a godan (五段) verb
 */
function conjugateGodan(reading: string): Conjugations | null {
  const lastChar = reading.slice(-1)
  const stem = reading.slice(0, -1)
  const endings = GODAN_ENDINGS[lastChar]

  if (!endings) {
    return null
  }

  // Special case for 行く (いく/ゆく) - uses って/った instead of いて/いた
  const isIku = reading === 'いく' || reading === 'ゆく'

  return {
    dictionary: reading,
    polite: stem + endings.i + 'ます',
    negative: stem + endings.a + 'ない',
    past: isIku ? stem + 'った' : stem + endings.ta,
    te: isIku ? stem + 'って' : stem + endings.te,
  }
}

/**
 * Conjugate する verb
 */
function conjugateSuru(word: string, reading: string): Conjugations {
  // Handle noun + する compounds (e.g., 勉強する)
  const hasSuru = reading.endsWith('する')
  const stem = hasSuru ? reading.slice(0, -2) : ''

  return {
    dictionary: hasSuru ? reading : word,
    polite: stem + 'します',
    negative: stem + 'しない',
    past: stem + 'した',
    te: stem + 'して',
  }
}

/**
 * Conjugate 来る verb
 */
function conjugateKuru(reading: string): Conjugations {
  const stem = reading.endsWith('くる') ? reading.slice(0, -2) : ''

  return {
    dictionary: reading,
    polite: stem + 'きます',
    negative: stem + 'こない',
    past: stem + 'きた',
    te: stem + 'きて',
  }
}

/**
 * Conjugate an i-adjective
 */
function conjugateIAdjective(reading: string): Conjugations {
  const stem = reading.slice(0, -1) // Remove い

  return {
    dictionary: reading,
    polite: reading + 'です',
    negative: stem + 'くない',
    past: stem + 'かった',
    te: stem + 'くて',
  }
}

/**
 * Generate conjugations for a word
 * Returns undefined if word is not conjugatable
 */
export function conjugate(
  word: string,
  reading: string,
  partOfSpeech: string[]
): Conjugations | undefined {
  const verbType = detectVerbType(partOfSpeech)

  if (!verbType) {
    return undefined
  }

  let conjugations: Conjugations | null = null

  switch (verbType) {
    case 'ichidan':
      conjugations = conjugateIchidan(reading)
      break
    case 'godan':
      conjugations = conjugateGodan(reading)
      break
    case 'suru':
      conjugations = conjugateSuru(word, reading)
      break
    case 'kuru':
      conjugations = conjugateKuru(reading)
      break
    case 'i-adjective':
      conjugations = conjugateIAdjective(reading)
      break
  }

  if (!conjugations) {
    return undefined
  }

  // If word has kanji, replace reading with kanji form where possible
  if (word !== reading) {
    // For dictionary form, use kanji
    conjugations.dictionary = word

    // For other forms, we keep the conjugated reading
    // A more sophisticated approach would map kanji to readings
  }

  return conjugations
}
