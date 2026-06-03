import { Database } from 'bun:sqlite'
import { normalizeJapaneseText, normalizeKana } from '../domain/normalize'
import type { ReviewStatus, SourceKind, TargetLanguage } from '../domain/types'

export interface CanonicalLookupEntry {
  id: string
  word: string
  reading: string
  pos: string[]
  definitions: string[]
}

export interface CanonicalLookupMatch {
  surface: string
  reading?: string
  matchType: string
  score: number
}

export interface CanonicalLookupResult {
  query: string
  matched: CanonicalLookupMatch | null
  entries: CanonicalLookupEntry[]
}

interface AliasRow {
  surface: string
  reading: string | null
  alias_type: string
  score: number
  entry_public_id: string
  ranking_json: string
}

interface EntryRow {
  public_id: string
  language?: string
  entry_type?: string
  primary_form: string
  primary_reading: string
  ranking_json?: string
}

interface SenseRow {
  public_id: string
  part_of_speech_json: string
  sense_order: number
  applies_to_form_ids_json?: string
  applies_to_reading_ids_json?: string
  domain_json?: string
  register_json?: string
  misc_json?: string
}

interface GlossRow {
  text: string
}

interface FormRow {
  public_id: string
  text: string
  normalized_text: string
  script: string
  is_primary: number
  tags_json: string
}

interface ReadingRow {
  public_id: string
  text: string
  normalized_text: string
  system: string
  is_primary: number
  applies_to_form_ids_json: string
  pitch_accent_json: string | null
  tags_json: string
}

interface GlossDetailRow {
  public_id: string
  lang: TargetLanguage
  text: string
  source_type: 'source' | 'manual' | 'ai'
  review_status: ReviewStatus
}

interface ExampleDetailRow {
  public_id: string
  sense_public_id: string | null
  lang: TargetLanguage
  japanese: string
  translation: string
}

interface SourceRefRow {
  source_kind: SourceKind
  source_id: string | null
  license: string | null
  imported_at: string
  model: string | null
  prompt_version: string | null
  input_refs_json: string | null
  review_status: ReviewStatus | null
}

interface KanjiRow {
  public_id: string
  literal: string
  stats_json: string
}

interface KanjiMeaningRow {
  lang: TargetLanguage
  text: string
}

interface KanjiReadingRow {
  reading_type: 'onyomi' | 'kunyomi' | 'nanori'
  text: string
}

export interface CanonicalLookupInput {
  query?: string
  surface?: string
  lemma?: string
  reading?: string
  lang: TargetLanguage
  limit?: number
}

export interface CanonicalSourceRef {
  kind: SourceKind
  sourceId?: string
  license?: string
  importedAt: string
  model?: string
  promptVersion?: string
  inputRefs?: string[]
  reviewStatus?: ReviewStatus
}

export interface CanonicalFormDetail {
  id: string
  text: string
  normalizedText: string
  script: string
  isPrimary: boolean
  tags: string[]
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalReadingDetail {
  id: string
  text: string
  normalizedText: string
  system: string
  isPrimary: boolean
  appliesToFormIds: string[] | 'all'
  pitchAccent?: unknown
  tags: string[]
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalGlossDetail {
  id: string
  lang: TargetLanguage
  text: string
  sourceType: 'source' | 'manual' | 'ai'
  reviewStatus: ReviewStatus
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalExampleDetail {
  id: string
  senseId?: string
  lang: TargetLanguage
  japanese: string
  translation: string
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalSenseDetail {
  id: string
  order: number
  partOfSpeech: string[]
  appliesToFormIds: string[] | 'all'
  appliesToReadingIds: string[] | 'all'
  domain: string[]
  register: string[]
  misc: string[]
  glosses: CanonicalGlossDetail[]
  examples: CanonicalExampleDetail[]
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalEntryDetail {
  id: string
  language: string
  entryType: string
  primaryForm: string
  primaryReading: string
  ranking: unknown
  forms: CanonicalFormDetail[]
  readings: CanonicalReadingDetail[]
  senses: CanonicalSenseDetail[]
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalKanjiMeaningDetail {
  lang: TargetLanguage
  text: string
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalKanjiReadingDetail {
  type: 'onyomi' | 'kunyomi' | 'nanori'
  text: string
  sourceRefs: CanonicalSourceRef[]
}

export interface CanonicalKanjiDetail {
  id: string
  literal: string
  meanings: CanonicalKanjiMeaningDetail[]
  readings: CanonicalKanjiReadingDetail[]
  stats: unknown
  sourceRefs: CanonicalSourceRef[]
}

export class CanonicalLookupService {
  private static readonly MIN_ALIAS_PREFETCH = 100
  private static readonly MAX_ALIAS_PREFETCH = 500

  constructor(private readonly db: Database) {
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  lookup(input: CanonicalLookupInput): CanonicalLookupResult {
    const limit = input.limit ?? 3
    const aliasPrefetchLimit = Math.min(
      Math.max(limit * 50, CanonicalLookupService.MIN_ALIAS_PREFETCH),
      CanonicalLookupService.MAX_ALIAS_PREFETCH
    )
    const candidates = this.buildQueryCandidates(input)
    const bestAliases = new Map<string, AliasRow>()

    for (const candidate of candidates) {
      const rows = this.lookupAliases(candidate.value, candidate.kind, aliasPrefetchLimit)
      for (const row of rows) {
        const existing = bestAliases.get(row.entry_public_id)
        if (!existing || this.rankAlias(row) > this.rankAlias(existing)) {
          bestAliases.set(row.entry_public_id, row)
        }
      }
    }

    const aliases = [...bestAliases.values()]
      .sort((left, right) => this.rankAlias(right) - this.rankAlias(left))
      .slice(0, limit)

    const entries = aliases
      .map((alias) => this.buildEntry(alias.entry_public_id, input.lang))
      .filter((entry): entry is CanonicalLookupEntry => Boolean(entry))

    const topAlias = aliases[0]
    return {
      query: input.query ?? input.surface ?? input.lemma ?? input.reading ?? '',
      matched: topAlias
        ? {
          surface: topAlias.surface,
          reading: topAlias.reading ?? undefined,
          matchType: topAlias.alias_type,
          score: topAlias.score,
        }
        : null,
      entries,
    }
  }

  getEntry(id: string, lang?: TargetLanguage): CanonicalEntryDetail | null {
    const entry = this.db.query<Required<EntryRow>, [string]>(`
      SELECT public_id, language, entry_type, primary_form, primary_reading, ranking_json
      FROM entries
      WHERE public_id = ?1
    `).get(id)

    if (!entry) return null

    const forms = this.db.query<FormRow, [string]>(`
      SELECT public_id, text, normalized_text, script, is_primary, tags_json
      FROM forms
      WHERE entry_public_id = ?1
      ORDER BY is_primary DESC, id ASC
    `).all(id).map((form) => ({
      id: form.public_id,
      text: form.text,
      normalizedText: form.normalized_text,
      script: form.script,
      isPrimary: form.is_primary === 1,
      tags: this.parseJson<string[]>(form.tags_json, []),
      sourceRefs: this.getSourceRefs('form', form.public_id),
    }))

    const readings = this.db.query<ReadingRow, [string]>(`
      SELECT public_id, text, normalized_text, system, is_primary,
        applies_to_form_ids_json, pitch_accent_json, tags_json
      FROM readings
      WHERE entry_public_id = ?1
      ORDER BY is_primary DESC, id ASC
    `).all(id).map((reading) => ({
      id: reading.public_id,
      text: reading.text,
      normalizedText: reading.normalized_text,
      system: reading.system,
      isPrimary: reading.is_primary === 1,
      appliesToFormIds: this.parseJson<string[] | 'all'>(reading.applies_to_form_ids_json, 'all'),
      pitchAccent: reading.pitch_accent_json ? this.parseJson<unknown>(reading.pitch_accent_json, undefined) : undefined,
      tags: this.parseJson<string[]>(reading.tags_json, []),
      sourceRefs: this.getSourceRefs('reading', reading.public_id),
    }))

    const senses = this.db.query<Required<SenseRow>, [string]>(`
      SELECT public_id, sense_order, part_of_speech_json, applies_to_form_ids_json,
        applies_to_reading_ids_json, domain_json, register_json, misc_json
      FROM senses
      WHERE entry_public_id = ?1
      ORDER BY sense_order ASC
    `).all(id).map((sense) => ({
      id: sense.public_id,
      order: sense.sense_order,
      partOfSpeech: this.parseJson<string[]>(sense.part_of_speech_json, []),
      appliesToFormIds: this.parseJson<string[] | 'all'>(sense.applies_to_form_ids_json, 'all'),
      appliesToReadingIds: this.parseJson<string[] | 'all'>(sense.applies_to_reading_ids_json, 'all'),
      domain: this.parseJson<string[]>(sense.domain_json, []),
      register: this.parseJson<string[]>(sense.register_json, []),
      misc: this.parseJson<string[]>(sense.misc_json, []),
      glosses: this.getGlosses(sense.public_id, lang),
      examples: this.getExamples(sense.public_id, lang),
      sourceRefs: this.getSourceRefs('sense', sense.public_id),
    }))

    return {
      id: entry.public_id,
      language: entry.language,
      entryType: entry.entry_type,
      primaryForm: entry.primary_form,
      primaryReading: entry.primary_reading,
      ranking: this.parseJson<unknown>(entry.ranking_json, {}),
      forms,
      readings,
      senses,
      sourceRefs: this.getSourceRefs('entry', entry.public_id),
    }
  }

  getKanji(literal: string, lang?: TargetLanguage): CanonicalKanjiDetail | null {
    const kanji = this.db.query<KanjiRow, [string]>(`
      SELECT public_id, literal, stats_json
      FROM kanji_characters
      WHERE literal = ?1
    `).get(literal)

    if (!kanji) return null

    const meaningRows = lang
      ? this.db.query<KanjiMeaningRow, [string, string]>(`
        SELECT lang, text
        FROM kanji_meanings
        WHERE kanji_public_id = ?1 AND lang = ?2
        ORDER BY id ASC
      `).all(kanji.public_id, lang)
      : this.db.query<KanjiMeaningRow, [string]>(`
        SELECT lang, text
        FROM kanji_meanings
        WHERE kanji_public_id = ?1
        ORDER BY id ASC
      `).all(kanji.public_id)

    const readings = this.db.query<KanjiReadingRow, [string]>(`
      SELECT reading_type, text
      FROM kanji_readings
      WHERE kanji_public_id = ?1
      ORDER BY
        CASE reading_type
          WHEN 'onyomi' THEN 1
          WHEN 'kunyomi' THEN 2
          WHEN 'nanori' THEN 3
          ELSE 4
        END,
        id ASC
    `).all(kanji.public_id).map((reading) => ({
      type: reading.reading_type,
      text: reading.text,
      sourceRefs: this.getSourceRefs('kanji_reading', `${kanji.public_id}:${reading.reading_type}:${reading.text}`),
    }))

    return {
      id: kanji.public_id,
      literal: kanji.literal,
      meanings: meaningRows.map((meaning) => ({
        lang: meaning.lang,
        text: meaning.text,
        sourceRefs: this.getSourceRefs('kanji_meaning', `${kanji.public_id}:${meaning.lang}:${meaning.text}`),
      })),
      readings,
      stats: this.parseJson<unknown>(kanji.stats_json, {}),
      sourceRefs: this.getSourceRefs('kanji', kanji.public_id),
    }
  }

  private buildQueryCandidates(input: CanonicalLookupInput): Array<{ kind: 'surface' | 'reading'; value: string }> {
    const candidates: Array<{ kind: 'surface' | 'reading'; value: string }> = []
    const seen = new Set<string>()

    const add = (kind: 'surface' | 'reading', value: string | undefined): void => {
      const normalized = kind === 'reading' ? normalizeKana(value ?? '') : normalizeJapaneseText(value ?? '')
      if (!normalized) return
      const key = `${kind}:${normalized}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ kind, value: normalized })
    }

    add('surface', input.lemma)
    add('surface', input.surface)
    add('surface', input.query)
    add('reading', input.reading)
    add('reading', input.query)
    add('reading', input.surface)

    return candidates
  }

  private lookupAliases(value: string, kind: 'surface' | 'reading', limit: number): AliasRow[] {
    if (kind === 'reading') {
      return this.db.query<AliasRow, [string, number]>(`
        SELECT
          lookup_aliases.surface,
          lookup_aliases.reading,
          lookup_aliases.alias_type,
          lookup_aliases.score,
          lookup_aliases.entry_public_id,
          entries.ranking_json
        FROM lookup_aliases
        JOIN entries ON entries.public_id = lookup_aliases.entry_public_id
        WHERE lookup_aliases.normalized_reading = ?1 OR lookup_aliases.normalized_surface = ?1
        ORDER BY score DESC, alias_type ASC, surface ASC
        LIMIT ?2
      `).all(value, limit)
    }

    return this.db.query<AliasRow, [string, number]>(`
      SELECT
        lookup_aliases.surface,
        lookup_aliases.reading,
        lookup_aliases.alias_type,
        lookup_aliases.score,
        lookup_aliases.entry_public_id,
        entries.ranking_json
      FROM lookup_aliases
      JOIN entries ON entries.public_id = lookup_aliases.entry_public_id
      WHERE lookup_aliases.normalized_surface = ?1
      ORDER BY score DESC, alias_type ASC, surface ASC
      LIMIT ?2
    `).all(value, limit)
  }

  private rankAlias(alias: AliasRow): number {
    const typeBoost: Record<string, number> = {
      dictionary: 5,
      variant: 4,
      reading: 3,
      kana: 2,
      normalized: 1,
    }
    return alias.score + (typeBoost[alias.alias_type] ?? 0) + this.rankSignalsBoost(alias.ranking_json)
  }

  private rankSignalsBoost(rankingJson: string): number {
    const ranking = this.parseJson<{
      common?: boolean
      frequency?: number
      jlpt?: number
      priority?: string[]
    }>(rankingJson, {})

    let boost = 0
    if (ranking.common) boost += 2
    if (ranking.priority?.some((value) => /^(ichi|news|spec|gai)[12]$/.test(value))) boost += 1
    if (typeof ranking.frequency === 'number') {
      if (ranking.frequency <= 500) boost += 2
      else if (ranking.frequency <= 5000) boost += 1
    }
    return boost
  }

  private buildEntry(entryId: string, lang: TargetLanguage): CanonicalLookupEntry | null {
    const entry = this.db.query<EntryRow, [string]>(`
      SELECT public_id, primary_form, primary_reading
      FROM entries
      WHERE public_id = ?1
    `).get(entryId)

    if (!entry) return null

    const senses = this.db.query<SenseRow, [string]>(`
      SELECT public_id, part_of_speech_json, sense_order
      FROM senses
      WHERE entry_public_id = ?1
      ORDER BY sense_order ASC
    `).all(entryId)

    const pos = new Set<string>()
    const definitions: string[] = []

    for (const sense of senses) {
      for (const part of JSON.parse(sense.part_of_speech_json) as string[]) {
        pos.add(part)
      }

      const glosses = this.db.query<GlossRow, [string, string]>(`
        SELECT text
        FROM glosses
        WHERE sense_public_id = ?1 AND lang = ?2
        ORDER BY id ASC
      `).all(sense.public_id, lang)

      for (const gloss of glosses) {
        if (!definitions.includes(gloss.text)) definitions.push(gloss.text)
      }
    }

    if (definitions.length === 0) return null

    return {
      id: entry.public_id,
      word: entry.primary_form,
      reading: entry.primary_reading,
      pos: [...pos],
      definitions,
    }
  }

  private getGlosses(senseId: string, lang?: TargetLanguage): CanonicalGlossDetail[] {
    const rows = lang
      ? this.db.query<GlossDetailRow, [string, string]>(`
        SELECT public_id, lang, text, source_type, review_status
        FROM glosses
        WHERE sense_public_id = ?1 AND lang = ?2
        ORDER BY id ASC
      `).all(senseId, lang)
      : this.db.query<GlossDetailRow, [string]>(`
        SELECT public_id, lang, text, source_type, review_status
        FROM glosses
        WHERE sense_public_id = ?1
        ORDER BY id ASC
      `).all(senseId)

    return rows.map((gloss) => ({
      id: gloss.public_id,
      lang: gloss.lang,
      text: gloss.text,
      sourceType: gloss.source_type,
      reviewStatus: gloss.review_status,
      sourceRefs: this.getSourceRefs('gloss', gloss.public_id),
    }))
  }

  private getExamples(senseId: string, lang?: TargetLanguage): CanonicalExampleDetail[] {
    const rows = lang
      ? this.db.query<ExampleDetailRow, [string, string]>(`
        SELECT public_id, sense_public_id, lang, japanese, translation
        FROM examples
        WHERE sense_public_id = ?1 AND lang = ?2
        ORDER BY id ASC
      `).all(senseId, lang)
      : this.db.query<ExampleDetailRow, [string]>(`
        SELECT public_id, sense_public_id, lang, japanese, translation
        FROM examples
        WHERE sense_public_id = ?1
        ORDER BY id ASC
      `).all(senseId)

    return rows.map((example) => ({
      id: example.public_id,
      senseId: example.sense_public_id ?? undefined,
      lang: example.lang,
      japanese: example.japanese,
      translation: example.translation,
      sourceRefs: this.getSourceRefs('example', example.public_id),
    }))
  }

  private getSourceRefs(ownerType: string, ownerId: string): CanonicalSourceRef[] {
    return this.db.query<SourceRefRow, [string, string]>(`
      SELECT source_kind, source_id, license, imported_at, model, prompt_version,
        input_refs_json, review_status
      FROM source_refs
      WHERE owner_type = ?1 AND owner_public_id = ?2
      ORDER BY id ASC
    `).all(ownerType, ownerId).map((ref) => ({
      kind: ref.source_kind,
      sourceId: ref.source_id ?? undefined,
      license: ref.license ?? undefined,
      importedAt: ref.imported_at,
      model: ref.model ?? undefined,
      promptVersion: ref.prompt_version ?? undefined,
      inputRefs: ref.input_refs_json ? this.parseJson<string[]>(ref.input_refs_json, []) : undefined,
      reviewStatus: ref.review_status ?? undefined,
    }))
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
}
