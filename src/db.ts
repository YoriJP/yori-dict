import { Database } from "bun:sqlite";
import type {
  ApiLang,
  LookupResponse,
  PublicEntry,
  PublicGloss,
  PublicHeadword,
  PublicExample,
  InflectionStep,
  PublicLanguageSource,
  PublicLookupItem,
  PublicSense,
  PublicSource,
  Xref
} from "./types";
import { normalizeQuery } from "./normalize";
import { deinflect, type DeinflectionCandidate } from "./deinflect";


type EntryRow = {
  id: string;
  source: "jmdict" | "generated";
  source_id: string;
  headword_language?: "ja";
  estimated_level?: PublicEntry["estimatedLevel"] | null;
};

type FormRow = {
  entry_id: string;
  text: string;
  reading: string | null;
  kind: "kanji" | "kana";
  common: 0 | 1;
  tags: string;
};

type SenseRow = {
  id: string;
  entry_id: string;
  lang: ApiLang;
  position: number;
  applies_to_kanji: string;
  applies_to_kana: string;
  part_of_speech: string;
  misc: string;
  field: string;
  dialect: string;
  info: string;
  related: string;
  antonym: string;
  language_source: string;
  pronunciations: string;
  pragmatic_functions: string;
  provenance: "source" | "generated";
  source_ref: string | null;
};

type GlossRow = {
  sense_id: string;
  text: string;
  source: "jmdict" | "generated";
  review_status: "source" | "checked";
  type: string | null;
};

type LookupCandidate = {
  rank: number;
  entryIds: string[];
  inflectionPath: InflectionStep[];
};

type ExampleRow = {
  text: string;
  translations: string;
  source: "sourced" | "generated";
  source_name: string | null;
  source_id: string | null;
  review_status: "source" | "checked";
};

export type LookupDb = {
  /** Returns only senses owned by `lang`; it never falls back to another language. */
  lookup(query: string, lang: ApiLang): LookupResponse;
  meta(): {
    apiVersion: "v1";
    dictionaryVersion: string | null;
    languages: ApiLang[];
    tags: Record<string, string>;
    sources: PublicSource[];
  };
  close(): void;
};

/** One entry with every explanation language it currently carries. */
export type JapaneseEntryGroups = {
  entry: Omit<PublicLookupItem, "senses" | "inflectionPath">;
  groups: Array<{ lang: ApiLang; senses: PublicSense[] }>;
};

export function openLookupDb(path: string): LookupDb {
  const db = new Database(path, { readonly: true });

  return {
    lookup(query, lang) {
      return lookup(db, query, lang);
    },
    meta() {
      return {
        apiVersion: "v1",
        dictionaryVersion: readMetadata(db, "dictDate"),
        languages: readJapaneseLanguages(db),
        tags: readTags(db),
        sources: japaneseSourceCredits
      };
    },
    close() {
      db.close();
    }
  };
}

/**
 * Explanation languages the Japanese dictionary actually holds senses in. A
 * language with no rows behind it is a gap, not a contract: lookup still
 * accepts it and Enrich-on-Lookup still fills it, but metadata does not claim
 * it exists. A consumer generating one artifact per language pair reads this
 * rather than discovering the emptiness one null at a time.
 */
export function readJapaneseLanguages(db: Database): ApiLang[] {
  return db.query<{ lang: ApiLang }, []>("select distinct lang from ja_senses order by lang")
    .all()
    .map(({ lang }) => lang);
}

/**
 * Every URL is absolute and resolvable, because an attribution a reader cannot
 * follow is not an attribution. The repository-relative paths these legacy
 * gloss credits used to carry named files rather than places.
 */
const repository = "https://github.com/YoriJP/yori-dict/blob/main";

const japaneseSourceCredits: PublicSource[] = [
  {
    name: "JMdict",
    license: "CC-BY-SA-4.0",
    url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
  },
  {
    name: "Tatoeba example sentences",
    license: "CC-BY-2.0-FR",
    url: "https://tatoeba.org/en/terms_of_use"
  },
  {
    name: "yomitan-jlpt-vocab estimated levels",
    license: "CC-BY-SA-4.0",
    url: "https://github.com/stephenmk/yomitan-jlpt-vocab"
  },
  {
    name: "Yori generated zh-TW glosses (legacy records)",
    license: "CC-BY-SA-4.0",
    url: `${repository}/sources/ai-glosses/zh-tw.jsonl`
  },
  {
    name: "Yori generated zh-CN glosses (legacy records)",
    license: "CC-BY-SA-4.0",
    url: `${repository}/sources/ai-glosses/zh-cn.jsonl`
  },
  {
    name: "Yori generated Korean glosses (legacy records)",
    license: "CC-BY-SA-4.0",
    url: `${repository}/sources/ai-glosses/ko.jsonl`
  },
  {
    name: "Yori generated examples",
    license: "CC-BY-SA-4.0",
    url: `${repository}/sources/ai-examples/generated.jsonl`
  }
];

/**
 * Streams every canonical entry with its sibling explanation-language groups.
 * Each group is read from its own senses, so a gloss can never be emitted
 * under a language other than the one that owns it.
 */
export function visitJapaneseEntries(path: string, visit: (record: JapaneseEntryGroups) => void): void {
  const db = new Database(path, { readonly: true });
  try {
    const languages = db.query<{ lang: ApiLang }, [string]>(
      "select distinct lang from ja_senses where entry_id = ? order by lang"
    );
    let after = "";
    while (true) {
      const ids = db.query<{ id: string }, [string]>(
        "select id from ja_entries where id > ? order by id limit 1000"
      ).all(after).map(({ id }) => id);
      if (ids.length === 0) return;
      for (const entryId of ids) {
        const entry = db.query<EntryRow, [string]>("select * from ja_entries where id = ?").get(entryId);
        if (!entry) continue;
        const headwords = readHeadwords(db, entryId);
        const headword = headwords[0];
        visit({
          entry: {
            id: entry.id,
            word: headword?.text ?? "",
            reading: headword?.reading ?? null,
            common: headwords.some((form) => form.common),
            source: entry.source,
            sourceId: entry.source_id,
            headwordLanguage: entry.headword_language ?? "ja",
            ...(entry.estimated_level ? { estimatedLevel: entry.estimated_level } : {}),
            headwords
          },
          groups: languages.all(entryId).map(({ lang }) => ({
            lang,
            senses: readSenses(db, entryId, lang)
          }))
        });
      }
      after = ids.at(-1)!;
    }
  } finally {
    db.close();
  }
}

function lookup(db: Database, query: string, lang: ApiLang): LookupResponse {
  const normalizedQuery = normalizeQuery(query);
  const candidates: LookupCandidate[] = [];

  const exactEntryIds = findEntryIds(db, normalizedQuery);
  if (exactEntryIds.length > 0) {
    candidates.push({
      rank: 0,
      entryIds: exactEntryIds,
      inflectionPath: []
    });
  }

  for (const candidate of deinflect(normalizedQuery)) {
    const candidateEntryIds = findEntryIds(db, candidate.text);
    if (candidateEntryIds.length === 0) continue;

    candidates.push({
      rank: matchRank(candidate),
      entryIds: candidateEntryIds,
      inflectionPath: [{ from: normalizedQuery, to: candidate.text, reason: candidate.reasons[0] ?? "deinflected" }]
    });
  }

  return { item: readBestItem(db, candidates, lang) };
}

function findEntryIds(db: Database, term: string): string[] {
  return db
    .query<{ entry_id: string }, [string]>(
      `select lt.entry_id
       from ja_lookup_terms lt
       join ja_forms f on f.entry_id = lt.entry_id and f.text = lt.term
       where lt.term = ?
       group by lt.entry_id
       order by
         max(f.common) desc,
         case when (
           select best.text
           from ja_forms best
           where best.entry_id = lt.entry_id
           order by best.common desc, case best.kind when 'kanji' then 0 else 1 end, best.text, best.reading
           limit 1
         ) = lt.term then 0 else 1 end,
         lt.entry_id`
    )
    .all(term)
    .map((row) => row.entry_id);
}

function matchRank(candidate: DeinflectionCandidate): number {
  return candidate.reasons.some((reason) => reason.includes("potential") || reason.includes("passive"))
    ? 20
    : 10;
}

function readBestItem(
  db: Database,
  candidates: LookupCandidate[],
  lang: ApiLang
): PublicLookupItem | null {
  // Several entries can share one written form. The requested language decides
  // which of them can answer: the first candidate entry, in match order, that
  // owns senses in that language. An entry with no sense in the requested
  // language is a miss for that language, never an entry to answer with
  // another language's senses, and never a reason to hide a sibling entry
  // that does explain the word in the requested language.
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    for (const entryId of candidate.entryIds) {
      const entry = readEntry(db, entryId, lang);
      if (entry && entry.senses.length > 0) return toLookupItem(entry, candidate.inflectionPath);
    }
  }
  return null;
}

function toLookupItem(entry: PublicEntry, inflectionPath: InflectionStep[]): PublicLookupItem {
  const headword = entry.headwords[0];
  return {
    id: entry.id,
    word: headword?.text ?? "",
    reading: headword?.reading ?? null,
    common: entry.headwords.some((item) => item.common),
    source: entry.source,
    sourceId: entry.sourceId,
    headwordLanguage: entry.headwordLanguage,
    ...(entry.estimatedLevel ? { estimatedLevel: entry.estimatedLevel } : {}),
    ...(inflectionPath.length > 0 ? { inflectionPath } : {}),
    headwords: entry.headwords,
    senses: entry.senses
  };
}

function readEntry(db: Database, entryId: string, lang: ApiLang): PublicEntry | null {
  const entry = db.query<EntryRow, [string]>("select * from ja_entries where id = ?").get(entryId);
  if (!entry) return null;
  return {
    id: entry.id,
    source: entry.source,
    sourceId: entry.source_id,
    headwordLanguage: entry.headword_language ?? "ja",
    ...(entry.estimated_level ? { estimatedLevel: entry.estimated_level } : {}),
    headwords: readHeadwords(db, entry.id),
    senses: readSenses(db, entry.id, lang)
  };
}

function readHeadwords(db: Database, entryId: string): PublicHeadword[] {
  return db
    .query<FormRow, [string]>(
      `select entry_id, text, reading, kind, common, tags
       from ja_forms
       where entry_id = ?
       order by common desc, case kind when 'kanji' then 0 else 1 end, text, reading`
    )
    .all(entryId)
    .map((row) => ({
      text: row.text,
      reading: row.reading,
      kind: row.kind,
      common: row.common === 1,
      tags: JSON.parse(row.tags) as string[]
    }));
}

function readSenses(db: Database, entryId: string, lang: ApiLang): PublicSense[] {
  return db
    .query<SenseRow, [string, ApiLang]>(
      `select * from ja_senses
       where entry_id = ? and lang = ?
       order by position`
    )
    .all(entryId, lang)
    .map((row) => ({
      id: row.id,
      position: row.position,
      appliesTo: {
        kanji: JSON.parse(row.applies_to_kanji) as string[],
        kana: JSON.parse(row.applies_to_kana) as string[]
      },
      partOfSpeech: JSON.parse(row.part_of_speech) as string[],
      ...whenPresent("misc", parseList<string>(row.misc)),
      ...whenPresent("field", parseList<string>(row.field)),
      ...whenPresent("dialect", parseList<string>(row.dialect)),
      ...whenPresent("info", parseList<string>(row.info)),
      ...whenPresent("related", parseList<Xref>(row.related)),
      ...whenPresent("antonym", parseList<Xref>(row.antonym)),
      ...whenPresent("languageSource", parseList<PublicLanguageSource>(row.language_source)),
      ...whenPresent("pronunciations", parseList<string>(row.pronunciations)),
      ...whenPresent("pragmaticFunctions", parseList<string>(row.pragmatic_functions)),
      ...whenPresent("examples", readExamples(db, row.id)),
      glosses: readGlosses(db, row.id, row.lang),
      evidenceIds: row.source_ref ? [row.source_ref] : [],
      provenance: row.provenance
    }));
}

function readExamples(db: Database, senseId: string): PublicExample[] {
  return db
    .query<ExampleRow, [string]>(
      `select text, translations, source, source_name, source_id, review_status
         from ja_examples where sense_id = ? order by position`
    )
    .all(senseId)
    .map((row) => ({
      text: row.text,
      translations: parseList<{ lang: string; text: string }>(row.translations),
      source: row.source,
      ...(row.source_name ? { sourceName: row.source_name } : {}),
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      reviewStatus: row.review_status
    }));
}

function parseList<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  return JSON.parse(value) as T[];
}

function whenPresent<K extends string, T>(key: K, values: T[]): Partial<Record<K, T[]>> {
  return values.length > 0 ? ({ [key]: values } as Record<K, T[]>) : {};
}

/**
 * The owning sense's language is stamped onto every gloss it returns, so a
 * gloss never travels without the language that explains it.
 */
function readGlosses(db: Database, senseId: string, lang: ApiLang): PublicGloss[] {
  return db
    .query<GlossRow, [string]>("select * from ja_glosses where sense_id = ? order by position")
    .all(senseId)
    .map((row) => ({
      text: row.text,
      lang,
      source: row.source,
      reviewStatus: row.review_status,
      ...(row.type ? { type: row.type } : {})
    }));
}

function readTags(db: Database): Record<string, string> {
  const raw = readMetadata(db, "tags");
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, string>;
}

function readMetadata(db: Database, key: string): string | null {
  try {
    const row = db.query<{ value: string }, [string]>("select value from ja_metadata where key = ?").get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}
