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
  Xref
} from "./types";
import { normalizeQuery } from "./normalize";
import { deinflect, type DeinflectionCandidate } from "./deinflect";
import { apiLanguages } from "./lang";

type EntryRow = {
  id: string;
  source: "jmdict";
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
  position: number;
  applies_to_kanji: string;
  applies_to_kana: string;
  part_of_speech: string;
  // Absent in databases built before these columns existed.
  misc?: string;
  field?: string;
  dialect?: string;
  info?: string;
  related?: string;
  antonym?: string;
  language_source?: string;
};

type GlossRow = {
  sense_id: string;
  lang: ApiLang;
  text: string;
  source: "jmdict" | "ai-assisted";
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
  lookup(query: string, requestedLang: ApiLang | null): LookupResponse;
  meta(): {
    apiVersion: "v1";
    dictionaryVersion: string | null;
    languages: string[];
    tags: Record<string, string>;
    sources: Array<{ name: string; license: string; url: string }>;
  };
  close(): void;
};

export function openLookupDb(path: string): LookupDb {
  const db = new Database(path, { readonly: true });

  return {
    lookup(query, requestedLang) {
      return lookup(db, query, requestedLang);
    },
    meta() {
      return {
        apiVersion: "v1",
        dictionaryVersion: readMetadata(db, "dictDate"),
        languages: apiLanguages,
        tags: readTags(db),
        sources: [
          {
            name: "JMdict",
            license: "CC-BY-SA-4.0",
            url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
          },
          {
            name: "Tatoeba example sentences",
            license: "CC BY 2.0 FR",
            url: "https://tatoeba.org/"
          },
          {
            name: "yomitan-jlpt-vocab estimated levels",
            license: "CC BY-SA 4.0",
            url: "https://github.com/stephenmk/yomitan-jlpt-vocab"
          },
          {
            name: "Yori AI-assisted zh-TW glosses",
            license: "CC-BY-SA-4.0",
            url: "sources/ai-glosses/zh-tw.jsonl"
          },
          {
            name: "Yori AI-assisted zh-CN glosses",
            license: "CC-BY-SA-4.0",
            url: "sources/ai-glosses/zh-cn.jsonl"
          },
          {
            name: "Yori AI-assisted Korean glosses",
            license: "CC-BY-SA-4.0",
            url: "sources/ai-glosses/ko.jsonl"
          },
          {
            name: "Yori generated examples",
            license: "CC-BY-SA-4.0",
            url: "sources/ai-examples/generated.jsonl"
          }
        ]
      };
    },
    close() {
      db.close();
    }
  };
}

function lookup(db: Database, query: string, requestedLang: ApiLang | null): LookupResponse {
  const normalizedQuery = normalizeQuery(query);
  const lang = requestedLang ?? "en";
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
       from lookup_terms lt
       join forms f on f.entry_id = lt.entry_id and f.text = lt.term
       where lt.term = ?
       group by lt.entry_id
       order by
         max(f.common) desc,
         case when (
           select best.text
           from forms best
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
  const best = candidates.sort((a, b) => a.rank - b.rank)[0];
  if (!best) return null;

  const entry = readEntries(db, [best.entryIds[0]], lang)[0];
  if (!entry) return null;

  return toLookupItem(entry, best.inflectionPath);
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

function readEntries(db: Database, entryIds: string[], lang: ApiLang): PublicEntry[] {
  if (entryIds.length === 0) return [];

  const entryQuery = db.query<EntryRow, [string]>(
    "select * from entries where id = ?"
  );
  const entries = entryIds
    .map((entryId) => entryQuery.get(entryId))
    .filter((entry): entry is EntryRow => entry !== null);

  return entries.map((entry) => ({
    id: entry.id,
    source: entry.source,
    sourceId: entry.source_id,
    headwordLanguage: entry.headword_language ?? "ja",
    ...(entry.estimated_level ? { estimatedLevel: entry.estimated_level } : {}),
    headwords: readHeadwords(db, entry.id),
    senses: readSenses(db, entry.id, lang)
  }));
}

function readHeadwords(db: Database, entryId: string): PublicHeadword[] {
  return db
    .query<FormRow, [string]>(
      `select entry_id, text, reading, kind, common, tags
       from forms
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
    .query<SenseRow, [string]>(
      `select * from senses
       where entry_id = ?
       order by position`
    )
    .all(entryId)
    .flatMap((row) => {
      const glosses = readGlosses(db, row.id, lang);
      if (glosses.length === 0) return [];

      return [
        {
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
          ...whenPresent("examples", readExamples(db, row.id)),
          glosses
        }
      ];
    });
}

function readExamples(db: Database, senseId: string): PublicExample[] {
  try {
    return db
      .query<Partial<ExampleRow>, [string]>(
        "select * from examples where sense_id = ? order by position"
      )
      .all(senseId)
      .map((row) => ({
        text: row.text ?? "",
        translations: parseList<{ lang: string; text: string }>(row.translations),
        source: row.source ?? "sourced",
        ...(row.source_name ? { sourceName: row.source_name } : {}),
        ...(row.source_id ? { sourceId: row.source_id } : {}),
        reviewStatus: row.review_status ?? "source"
      }));
  } catch {
    return [];
  }
}

function parseList<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  return JSON.parse(value) as T[];
}

function whenPresent<K extends string, T>(key: K, values: T[]): Partial<Record<K, T[]>> {
  return values.length > 0 ? ({ [key]: values } as Record<K, T[]>) : {};
}

// `select *` so that databases built before a column was added still load:
// missing columns read back as undefined and fall through to their defaults.
function readGlosses(db: Database, senseId: string, lang: ApiLang): PublicGloss[] {
  return db
    .query<Partial<GlossRow>, [string, ApiLang]>(
      "select * from glosses where sense_id = ? and lang = ? order by rowid"
    )
    .all(senseId, lang)
    .map((row) => ({
      text: row.text ?? "",
      source: row.source ?? "jmdict",
      reviewStatus: row.review_status ?? "source",
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
    const row = db.query<{ value: string }, [string]>("select value from metadata where key = ?").get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}
