import { Database } from "bun:sqlite";
import type {
  ApiLang,
  LookupResponse,
  PublicEntry,
  PublicGloss,
  PublicHeadword,
  PublicLookupItem,
  PublicSense
} from "./types";
import { normalizeQuery } from "./normalize";
import { deinflect, type DeinflectionCandidate } from "./deinflect";
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
  source: "jmdict" | "ai-assisted";
  review_status: "source" | "checked";
};

type LookupCandidate = {
  rank: number;
  entryIds: string[];
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
          },
          {
            name: "Yori AI-assisted zh-TW glosses",
            license: "TBD",
            url: "sources/ai-glosses/zh-tw.jsonl"
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
      entryIds: exactEntryIds
    });
  }

  for (const candidate of deinflect(normalizedQuery)) {
    const candidateEntryIds = findEntryIds(db, candidate.text);
    if (candidateEntryIds.length === 0) continue;

    candidates.push({
      rank: matchRank(candidate),
      entryIds: candidateEntryIds
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

  return toLookupItem(entry);
}

function toLookupItem(entry: PublicEntry): PublicLookupItem {
  const headword = entry.headwords[0];
  return {
    id: entry.id,
    word: headword?.text ?? "",
    reading: headword?.reading ?? null,
    common: entry.headwords.some((item) => item.common),
    source: entry.source,
    sourceId: entry.sourceId,
    headwords: entry.headwords,
    senses: entry.senses
  };
}

function readEntries(db: Database, entryIds: string[], lang: ApiLang): PublicEntry[] {
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
      glosses: readGlosses(db, row.id, lang)
    }));
}

function readGlosses(db: Database, senseId: string, lang: ApiLang): PublicGloss[] {
  try {
    return db
      .query<GlossRow, [string, ApiLang]>(
        "select sense_id, lang, text, source, review_status from glosses where sense_id = ? and lang = ? order by rowid"
      )
      .all(senseId, lang)
      .map((row) => ({
        text: row.text,
        source: row.source,
        reviewStatus: row.review_status
      }));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no such column: source")) {
      throw error;
    }

    return db
      .query<{ text: string }, [string, ApiLang]>(
        "select text from glosses where sense_id = ? and lang = ? order by rowid"
      )
      .all(senseId, lang)
      .map((row) => ({
        text: row.text,
        source: "jmdict",
        reviewStatus: "source"
      }));
  }
}

function readMetadata(db: Database, key: string): string | null {
  try {
    const row = db.query<{ value: string }, [string]>("select value from metadata where key = ?").get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}
