import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  EnglishEntry,
  EnglishExample,
  EnglishGloss,
  EnglishPronunciation,
  EnglishSense,
  EnglishSourceReference
} from "./english-types";
import { resolveEnglishLemma } from "./english-strip";
import { normalizeEnglishLookupTerm } from "./normalize";

export { normalizeEnglishLookupTerm };
import type { ApiLang, DictionaryMeta, PublicSource } from "./types";

/** One entry with every explanation language it currently carries. */
export type EnglishEntryGroups = {
  entry: Omit<EnglishEntry, "senses">;
  groups: Array<{ lang: ApiLang; senses: EnglishSense[] }>;
};

export type EnglishLookupDb = {
  /** Returns only senses owned by `lang`; it never falls back to another language. */
  lookup(query: string, lang: ApiLang): EnglishEntry | null;
  meta(): DictionaryMeta;
  close(): void;
};

/**
 * Explanation languages this dictionary actually holds senses in. A language
 * with no rows behind it is a gap, not a contract: lookup still accepts it and
 * Enrich-on-Lookup still fills it, but metadata does not claim it exists.
 */
export function readEnglishLanguages(db: Database): ApiLang[] {
  return db.query<{ lang: ApiLang }, []>("select distinct lang from en_senses order by lang")
    .all()
    .map(({ lang }) => lang);
}

/**
 * The English dictionary's own source credits, read from the metadata its
 * rebuild pinned. A source with no usable URL is dropped rather than published
 * as an attribution a reader cannot act on.
 */
export function readEnglishSourceCredits(db: Database): PublicSource[] {
  const raw = db.query<{ value: string }, [string]>("select value from en_metadata where key = ?")
    .get("sources")?.value;
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const credits = new Map<string, PublicSource>();
  for (const entry of parsed) {
    const source = entry as { name?: unknown; license?: unknown; url?: unknown };
    if (typeof source.name !== "string" || source.name === "") continue;
    if (typeof source.license !== "string" || source.license === "") continue;
    if (typeof source.url !== "string" || source.url.trim() === "") continue;
    // One credit per source: the metadata records it once per explanation
    // language it may publish in, and a reader needs the source, not the pair.
    credits.set(source.name, { name: source.name, license: source.license, url: source.url });
  }
  return [...credits.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}



export function englishEntryId(lookupTerm: string): string {
  return `yori:en:e_${digest(normalizeEnglishLookupTerm(lookupTerm))}`;
}

export function englishSenseId(identity: string): string {
  return `yori:en:s_${digest(identity)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/**
 * Reads canonical English entries out of the `en_*` tables. A lookup names one
 * explanation language and gets that language's own ordered senses or
 * nothing; there is no substitution from another language.
 */
export function openEnglishLookupDb(path: string): EnglishLookupDb {
  const db = new Database(path, { readonly: true });
  return {
    lookup(query, lang) {
      return lookupEnglishEntry(db, query, lang);
    },
    meta() {
      return { languages: readEnglishLanguages(db), sources: readEnglishSourceCredits(db) };
    },
    close() {
      db.close();
    }
  };
}

/**
 * Resolves a query to an entry, retrying an inflected surface against its
 * lemma. A client sends the word as it appeared in the text; making it
 * lemmatise first would mean reimplementing this with no lexicon to validate
 * against. The returned entry is the lemma's, with the lemma as `headword`, so
 * the card titles the real entry rather than the surface — and no field
 * carries the surface back, because the caller already holds the occurrence it
 * sent.
 */
export function lookupEnglishEntry(db: Database, query: string, lang: ApiLang): EnglishEntry | null {
  return lookupEnglishEntries(db, query, lang)[0] ?? null;
}

/**
 * Every entry the query reaches, in stable order, best first. One spelling can
 * be several lexemes — `best` and `better` are each three — and the order is a
 * ranking rather than a verdict, so the caller receives the rest instead of
 * being told the first one was the answer.
 */
export function lookupEnglishEntries(db: Database, query: string, lang: ApiLang): EnglishEntry[] {
  const resolved = resolveEnglishLookupTerm(db, query);
  if (!resolved) return [];
  return db
    .query<{ entry_id: string }, [string]>(
      "select distinct entry_id from en_lookup_terms where term = ? order by entry_id"
    )
    .all(resolved)
    .flatMap((row) => {
      const entry = readEnglishEntry(db, row.entry_id, lang);
      // An entry with no sense in the requested language is a miss for that
      // language, not an entry to answer with another language's senses.
      return entry && entry.senses.length > 0 ? [entry] : [];
    });
}

export function lookupEnglishCandidates(db: Database, query: string): Array<{ id: string; headword: string }> {
  const resolved = resolveEnglishLookupTerm(db, query);
  if (!resolved) return [];
  return db.query<{ entry_id: string }, [string]>(
    "select distinct entry_id from en_lookup_terms where term = ? order by entry_id"
  ).all(resolved).flatMap(({ entry_id }) => {
    const entry = readEnglishEntryHeader(db, entry_id);
    return entry ? [{ id: entry.id, headword: entry.headword }] : [];
  });
}

function resolveEnglishLookupTerm(db: Database, query: string): string | null {
  const term = normalizeEnglishLookupTerm(query);
  if (!term) return null;
  const exists = (candidate: string) => englishLookupTermExists(db, candidate);
  return exists(term) ? term : resolveEnglishLemma(term, exists);
}

/** Whether the lexicon carries this exact lookup term. The stripper's validator. */
export function englishLookupTermExists(db: Database, term: string): boolean {
  return db.query<{ term: string }, [string]>("select term from en_lookup_terms where term = ? limit 1")
    .get(term) !== null;
}

export function readEnglishEntry(db: Database, entryId: string, lang: ApiLang): EnglishEntry | null {
  const entry = readEnglishEntryHeader(db, entryId);
  return entry ? { ...entry, senses: readEnglishSenses(db, entryId, lang) } : null;
}

export function readEnglishEntryHeader(db: Database, entryId: string): Omit<EnglishEntry, "senses"> | null {
  const row = db.query<{ id: string; headword: string }, [string]>(
    "select id, headword from en_entries where id = ?"
  ).get(entryId);
  if (!row) return null;
  return {
    id: row.id,
    dictionary: "en",
    headword: row.headword,
    pronunciations: readEnglishPronunciations(db, entryId),
    sources: readEnglishSources(db, entryId)
  };
}

function readEnglishPronunciations(db: Database, entryId: string): EnglishPronunciation[] {
  return db.query<
    { ipa: string; region: string | null; source_name: string; source_ref: string | null },
    [string]
  >("select ipa, region, source_name, source_ref from en_pronunciations where entry_id = ? order by position")
    .all(entryId)
    .map((row) => ({
      ipa: row.ipa,
      ...(row.region ? { region: row.region } : {}),
      source: row.source_name,
      ...(row.source_ref ? { sourceRef: row.source_ref } : {})
    }));
}

/**
 * Concise source references for the entry: which pinned source supplied each
 * piece of canonical content, never the complete raw record.
 */
function readEnglishSources(db: Database, entryId: string): EnglishSourceReference[] {
  return db.query<EnglishSourceReference, [string]>(`
    select distinct source as source, source_version as sourceVersion, source_entry_id as sourceEntryId,
           license as license, attribution as attribution
      from en_entry_sources where entry_id = ?
     order by source, source_entry_id
  `).all(entryId);
}

export function readEnglishSenses(db: Database, entryId: string, lang: ApiLang): EnglishSense[] {
  return db.query<
    {
      id: string;
      lang: ApiLang;
      position: number;
      part_of_speech: string;
      registers: string;
      regions: string;
      domains: string;
      dated: number;
      usage: string;
      provenance: "source" | "generated";
      source_name: string | null;
      source_version: string | null;
      source_ref: string | null;
      generation_id: string | null;
    },
    [string, string]
  >("select * from en_senses where entry_id = ? and lang = ? order by position")
    .all(entryId, lang)
    .map((row): EnglishSense => {
      const generation = row.generation_id ? readEnglishGeneration(db, row.generation_id) : undefined;
      return {
      id: row.id,
      lang: row.lang,
      position: row.position,
      partOfSpeech: row.part_of_speech,
      glosses: readEnglishGlosses(db, row.id),
      registers: parseList(row.registers),
      regions: parseList(row.regions),
      domains: parseList(row.domains),
      dated: row.dated === 1,
      usage: parseList(row.usage),
      examples: readEnglishExamples(db, row.id),
      evidenceIds: row.source_ref ? [row.source_ref] : [],
      provenance: row.provenance,
      ...(row.source_name
        ? {
            source: {
              name: row.source_name,
              ...(row.source_version ? { version: row.source_version } : {}),
              ...(row.source_ref ? { ref: row.source_ref } : {})
            }
          }
        : {}),
      ...(generation ? { generation } : {})
      };
    });
}

function readEnglishGeneration(db: Database, generationId: string): EnglishSense["generation"] {
  const row = db.query<
    {
      model: string;
      provider: string;
      reasoning_effort: string;
      prompt_version: string;
      service_tier: string | null;
      review_outcome: string;
      created_at: string;
    },
    [string]
  >("select * from en_generations where id = ?").get(generationId);
  if (!row) return undefined;
  return {
    model: row.model,
    provider: row.provider,
    reasoningEffort: row.reasoning_effort,
    promptVersion: row.prompt_version,
    ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
    reviewOutcome: row.review_outcome,
    createdAt: row.created_at
  };
}

function readEnglishGlosses(db: Database, senseId: string): EnglishGloss[] {
  return db.query<
    { text: string; source: string; review_status: "source" | "checked"; type: string | null },
    [string]
  >("select text, source, review_status, type from en_glosses where sense_id = ? order by position")
    .all(senseId)
    .map((row) => ({
      text: row.text,
      source: row.source,
      reviewStatus: row.review_status,
      ...(row.type ? { type: row.type } : {})
    }));
}

function readEnglishExamples(db: Database, senseId: string): EnglishExample[] {
  return db.query<
    {
      text: string;
      translations: string;
      source: "sourced" | "generated";
      source_name: string | null;
      source_id: string | null;
      review_status: "source" | "checked";
    },
    [string]
  >(`select text, translations, source, source_name, source_id, review_status
       from en_examples where sense_id = ? order by position`)
    .all(senseId)
    .map((row) => ({
      text: row.text,
      ...(row.translations && row.translations !== "[]"
        ? { translations: JSON.parse(row.translations) as Array<{ lang: string; text: string }> }
        : {}),
      source: row.source,
      ...(row.source_name ? { sourceName: row.source_name } : {}),
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      reviewStatus: row.review_status
    }));
}

/**
 * Streams every canonical entry with its sibling explanation-language groups.
 * Each group is read from its own senses, so a gloss can never be emitted
 * under a language other than the one that owns it.
 */
export function visitEnglishEntries(path: string, visit: (record: EnglishEntryGroups) => void): void {
  const db = new Database(path, { readonly: true });
  try {
    const languages = db.query<{ lang: ApiLang }, [string]>(
      "select distinct lang from en_senses where entry_id = ? order by lang"
    );
    let after = "";
    while (true) {
      const terms = db.query<{ lookup_term: string; id: string }, [string]>(
        "select lookup_term, id from en_entries where lookup_term > ? order by lookup_term limit 1000"
      ).all(after);
      if (terms.length === 0) return;
      for (const { id } of terms) {
        const entry = readEnglishEntryHeader(db, id);
        if (!entry) continue;
        visit({
          entry,
          groups: languages.all(id).map(({ lang }) => ({ lang, senses: readEnglishSenses(db, id, lang) }))
        });
      }
      after = terms.at(-1)!.lookup_term;
    }
  } finally {
    db.close();
  }
}

/**
 * Structural problems that must never reach a published English release.
 *
 * The dictionary is validated as it streams, so identity checks live in the
 * validator rather than in one call: a duplicate entry or sense id is only
 * visible to a checker that remembers the ids it has already seen.
 */
export function createEnglishDictionaryValidator(): {
  check(entries: EnglishEntryGroups[]): string[];
} {
  const entryIds = new Set<string>();
  const senseIds = new Set<string>();
  return { check: (entries) => validateEntries(entries, entryIds, senseIds) };
}

/** Validates a whole English dictionary held in memory. */
export function validateEnglishDictionary(entries: EnglishEntryGroups[]): string[] {
  return validateEntries(entries, new Set<string>(), new Set<string>());
}

function validateEntries(
  entries: EnglishEntryGroups[],
  entryIds: Set<string>,
  senseIds: Set<string>
): string[] {
  const problems: string[] = [];
  for (const { entry, groups } of entries) {
    if (entry.dictionary !== "en") problems.push(`${entry.id}: wrong dictionary`);
    if (!entry.headword.trim()) problems.push(`${entry.id}: empty headword`);
    if (!entry.id.startsWith("yori:en:e_")) problems.push(`${entry.id}: invalid entry id`);
    if (entryIds.has(entry.id)) problems.push(`${entry.id}: duplicate entry id`);
    entryIds.add(entry.id);
    if (groups.length === 0) problems.push(`${entry.id}: no explanation language`);
    for (const group of groups) {
      if (group.senses.length === 0) problems.push(`${entry.id}: empty ${group.lang} group`);
      group.senses.forEach((sense, index) => {
        if (senseIds.has(sense.id)) problems.push(`${sense.id}: duplicate sense id`);
        senseIds.add(sense.id);
        if (sense.lang !== group.lang) problems.push(`${sense.id}: sense language disagrees with its group`);
        if (sense.position !== index + 1) problems.push(`${sense.id}: sense position is out of order`);
        if (sense.glosses.length === 0) problems.push(`${sense.id}: no glosses`);
        if (!sense.partOfSpeech.trim()) problems.push(`${sense.id}: empty part of speech`);
        if (sense.provenance === "source" && sense.evidenceIds.length === 0) {
          problems.push(`${sense.id}: imported sense has no evidence`);
        }
        if (sense.provenance === "generated" && (sense.evidenceIds.length > 0 || !sense.generation)) {
          problems.push(`${sense.id}: invalid generated provenance`);
        }
      });
    }
  }
  return problems;
}

function parseList(value: string | null | undefined): string[] {
  return value ? (JSON.parse(value) as string[]) : [];
}
