export type YoriEntityType = 'entry' | 'sense' | 'form' | 'reading' | 'gloss' | 'example' | 'alias' | 'kanji'

export type IdRegistrySection =
  | 'entries'
  | 'senses'
  | 'forms'
  | 'readings'
  | 'glosses'
  | 'examples'
  | 'aliases'
  | 'kanjis'

export interface IdRegistry {
  schemaVersion: '1.0.0'
  next: Record<IdRegistrySection, number>
  entries: Record<string, string>
  senses: Record<string, string>
  forms: Record<string, string>
  readings: Record<string, string>
  glosses: Record<string, string>
  examples: Record<string, string>
  aliases: Record<string, string>
  kanjis: Record<string, string>
}

const PREFIX_BY_TYPE: Record<YoriEntityType, string> = {
  entry: 'yde',
  sense: 'yds',
  form: 'ydf',
  reading: 'ydr',
  gloss: 'ydg',
  example: 'ydx',
  alias: 'yda',
  kanji: 'ydk',
}

const SECTION_BY_TYPE: Record<YoriEntityType, IdRegistrySection> = {
  entry: 'entries',
  sense: 'senses',
  form: 'forms',
  reading: 'readings',
  gloss: 'glosses',
  example: 'examples',
  alias: 'aliases',
  kanji: 'kanjis',
}

export function createEmptyIdRegistry(): IdRegistry {
  return {
    schemaVersion: '1.0.0',
    next: {
      entries: 1,
      senses: 1,
      forms: 1,
      readings: 1,
      glosses: 1,
      examples: 1,
      aliases: 1,
      kanjis: 1,
    },
    entries: {},
    senses: {},
    forms: {},
    readings: {},
    glosses: {},
    examples: {},
    aliases: {},
    kanjis: {},
  }
}

export function formatYoriId(type: YoriEntityType, value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${type} id number: ${value}`)
  }
  return `${PREFIX_BY_TYPE[type]}_${String(value).padStart(8, '0')}`
}

export function registrySectionFor(type: YoriEntityType): IdRegistrySection {
  return SECTION_BY_TYPE[type]
}

export function getOrCreateYoriId(
  registry: IdRegistry,
  type: YoriEntityType,
  sourceKey: string
): string {
  if (!sourceKey.trim()) {
    throw new Error('sourceKey must not be empty')
  }

  const section = registrySectionFor(type)
  const existing = registry[section][sourceKey]
  if (existing) return existing

  const nextValue = registry.next[section]
  const id = formatYoriId(type, nextValue)
  registry[section][sourceKey] = id
  registry.next[section] = nextValue + 1
  return id
}

export function validateYoriId(type: YoriEntityType, id: string): boolean {
  return new RegExp(`^${PREFIX_BY_TYPE[type]}_\\d{8}$`).test(id)
}
