import { Database } from "bun:sqlite";
import type {
  ApiLang,
  LookupMatch,
  LookupResponse,
  PublicEntry,
  PublicGloss,
  PublicHeadword,
  PublicSense
} from "./types";
import { normalizeQuery } from "./normalize";
import { deinflect } from "./deinflect";
import { apiLanguages } from "./lang";

type EntryRow = {
  id: string;
  source: "jmdict";
  source_id: string;
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
};

type GlossRow = {
  sense_id: string;
  lang: ApiLang;
  text: string;
};

export type LookupDb = {
  lookup(query: string, requestedLang: ApiLang | null): LookupResponse;
  meta(): {
    apiVersion: "v1";
    dictionaryVersion: string | null;
    languages: string[];
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
        sources: [
          {
            name: "JMdict",
            license: "CC-BY-SA-4.0",
            url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
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
  const exactEntryIds = findEntryIds(db, normalizedQuery);
  const matches: LookupMatch[] = [];
  const entryIds = new Set<string>();

  if (exactEntryIds.length > 0) {
    matches.push({
      input: normalizedQuery,
      matchedForm: normalizedQuery,
      matchType: "exact",
      reasons: []
    });
    for (const entryId of exactEntryIds) entryIds.add(entryId);
  }

  for (const candidate of deinflect(normalizedQuery)) {
    const candidateEntryIds = findEntryIds(db, candidate.text);
    if (candidateEntryIds.length === 0) continue;

    matches.push({
      input: normalizedQuery,
      matchedForm: candidate.text,
      matchType: "deinflected",
      reasons: candidate.reasons
    });
    for (const entryId of candidateEntryIds) entryIds.add(entryId);
  }

  return {
    query,
    normalizedQuery,
    requestedLang,
    matches,
    entries: readEntries(db, Array.from(entryIds), requestedLang)
  };
}

function findEntryIds(db: Database, term: string): string[] {
  return db
    .query<{ entry_id: string }, [string]>(
      "select distinct entry_id from lookup_terms where term = ? order by entry_id"
    )
    .all(term)
    .map((row) => row.entry_id);
}

function readEntries(db: Database, entryIds: string[], requestedLang: ApiLang | null): PublicEntry[] {
  if (entryIds.length === 0) return [];

  const entryQuery = db.query<EntryRow, [string]>(
    "select id, source, source_id from entries where id = ?"
  );
  const entries = entryIds
    .map((entryId) => entryQuery.get(entryId))
    .filter((entry): entry is EntryRow => entry !== null);

  return entries.map((entry) => ({
    id: entry.id,
    source: entry.source,
    sourceId: entry.source_id,
    headwords: readHeadwords(db, entry.id),
    senses: readSenses(db, entry.id, requestedLang)
  }));
}

function readHeadwords(db: Database, entryId: string): PublicHeadword[] {
  return db
    .query<FormRow, [string]>(
      `select entry_id, text, reading, kind, common, tags
       from forms
       where entry_id = ?
       order by case kind when 'kanji' then 0 else 1 end, text, reading`
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

function readSenses(db: Database, entryId: string, requestedLang: ApiLang | null): PublicSense[] {
  return db
    .query<SenseRow, [string]>(
      `select id, entry_id, position, applies_to_kanji, applies_to_kana, part_of_speech
       from senses
       where entry_id = ?
       order by position`
    )
    .all(entryId)
    .map((row) => ({
      id: row.id,
      position: row.position,
      appliesTo: {
        kanji: JSON.parse(row.applies_to_kanji) as string[],
        kana: JSON.parse(row.applies_to_kana) as string[]
      },
      partOfSpeech: JSON.parse(row.part_of_speech) as string[],
      glosses: groupGlosses(readGlosses(db, row.id), requestedLang)
    }));
}

function readGlosses(db: Database, senseId: string): GlossRow[] {
  return db
    .query<GlossRow, [string]>(
      "select sense_id, lang, text from glosses where sense_id = ? order by lang, rowid"
    )
    .all(senseId);
}

function groupGlosses(rows: GlossRow[], requestedLang: ApiLang | null): Record<string, PublicGloss[]> {
  const langOrder = requestedLang ? [requestedLang, "en"] : ["en"];
  const remaining = Array.from(new Set(rows.map((row) => row.lang))).sort();
  const orderedLangs = Array.from(new Set([...langOrder, ...remaining]));
  const grouped: Record<string, PublicGloss[]> = {};

  for (const lang of orderedLangs) {
    const glosses = rows
      .filter((row) => row.lang === lang)
      .map((row) => ({
        text: row.text,
        source: "jmdict" as const,
        reviewStatus: "source" as const
      }));
    if (glosses.length > 0 || lang === requestedLang || lang === "en") {
      grouped[lang] = glosses;
    }
  }

  return grouped;
}

function readMetadata(db: Database, key: string): string | null {
  try {
    const row = db.query<{ value: string }, [string]>("select value from metadata where key = ?").get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}
