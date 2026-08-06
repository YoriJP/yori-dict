import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LookupDb } from "./db";
import type {
  AttemptRecord,
  EnrichmentRepository,
  SourceEvidence,
  TargetDictionary
} from "./on-demand-dictionary";
import type { ApiLang, PublicExample, PublicLookupItem } from "./types";

export type PersistentEnrichmentRepository = EnrichmentRepository & {
  acceptedEntries(): PublicLookupItem[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnrichmentRepository(
  path: string,
  releasedDb: LookupDb,
  sourceLookup: (query: string, targetDictionary: TargetDictionary) => SourceEvidence[] = () => []
): PersistentEnrichmentRepository {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  ensureSchema(db);

  const readEntry = db.prepare<{ entry_json: string }, [string, string]>(
    `select e.entry_json
       from on_demand_lookup_terms t
       join on_demand_entries e on e.entry_id = t.entry_id
      where t.dictionary = ? and t.term = ?
      order by e.entry_id
      limit 1`
  );
  const readExamples = db.prepare<{ sense_id: string; example_json: string }, [string]>(
    `select sense_id, example_json from on_demand_examples where entry_id = ? order by sense_id`
  );
  const readExample = db.prepare<{ example_json: string }, [string]>(
    `select example_json from on_demand_examples where sense_id = ?`
  );
  const upsertEntry = db.prepare(
    `insert into on_demand_entries (entry_id, dictionary, headword, entry_json, accepted_at)
     values (?, 'ja', ?, ?, ?)
     on conflict(entry_id) do update set headword = excluded.headword, entry_json = excluded.entry_json`
  );
  const deleteTerms = db.prepare(`delete from on_demand_lookup_terms where entry_id = ?`);
  const insertTerm = db.prepare(
    `insert or ignore into on_demand_lookup_terms (dictionary, term, entry_id) values ('ja', ?, ?)`
  );
  const upsertSense = db.prepare(
    `insert into on_demand_senses (sense_id, entry_id) values (?, ?)
     on conflict(sense_id) do update set entry_id = excluded.entry_id`
  );
  const findEntryForSense = db.prepare<{ entry_id: string }, [string]>(
    `select entry_id from on_demand_senses where sense_id = ?`
  );
  const upsertExample = db.prepare(
    `insert into on_demand_examples (sense_id, entry_id, example_json)
     values (?, ?, ?)
     on conflict(sense_id) do update set entry_id = excluded.entry_id, example_json = excluded.example_json`
  );
  const insertAttempt = db.prepare(`insert into on_demand_attempts (attempt_json) values (?)`);
  const readTerminal = db.prepare<{ outcome: string }, [string]>(
    `select outcome from on_demand_terminal_outcomes where outcome_key = ?`
  );
  const upsertTerminal = db.prepare(
    `insert into on_demand_terminal_outcomes (outcome_key, outcome) values (?, ?)
     on conflict(outcome_key) do update set outcome = excluded.outcome`
  );

  function withExamples(entry: PublicLookupItem): PublicLookupItem {
    const examples = new Map(
      readExamples.all(entry.id).map((row) => [row.sense_id, JSON.parse(row.example_json) as PublicExample])
    );
    return {
      ...entry,
      senses: entry.senses.map((sense) => {
        const example = examples.get(sense.id) ?? readExample.get(sense.id)?.example_json;
        if (!example) return sense;
        const parsed = typeof example === "string" ? (JSON.parse(example) as PublicExample) : example;
        return { ...sense, examples: [parsed] };
      })
    };
  }

  function generatedEntry(query: string, targetDictionary: TargetDictionary): PublicLookupItem | null {
    const row = readEntry.get(targetDictionary, query);
    return row ? withExamples(JSON.parse(row.entry_json) as PublicLookupItem) : null;
  }

  return {
    findReleased(query, targetDictionary) {
      return targetDictionary === "ja" ? releasedDb.lookup(query, "en").item : null;
    },
    findOverlay(query, targetDictionary) {
      const generated = generatedEntry(query, targetDictionary);
      if (generated) return generated;
      if (targetDictionary !== "ja") return null;
      const released = releasedDb.lookup(query, "en").item;
      return released ? withExamples(released) : null;
    },
    findSources(query, targetDictionary) {
      return sourceLookup(query, targetDictionary);
    },
    saveEntry(entry) {
      db.transaction(() => {
        upsertEntry.run(entry.id, entry.word, JSON.stringify(entry), new Date().toISOString());
        deleteTerms.run(entry.id);
        const terms = new Set([
          entry.word,
          ...(entry.reading ? [entry.reading] : []),
          ...entry.headwords.flatMap((headword) => [headword.text, ...(headword.reading ? [headword.reading] : [])])
        ]);
        for (const term of terms) insertTerm.run(term, entry.id);
        for (const sense of entry.senses) upsertSense.run(sense.id, entry.id);
      })();
    },
    saveExample(senseId, example) {
      const entryId = findEntryForSense.get(senseId)?.entry_id ?? `released:${senseId}`;
      upsertExample.run(senseId, entryId, JSON.stringify(example));
    },
    recordAttempt(attempt) {
      insertAttempt.run(JSON.stringify(attempt));
    },
    terminalOutcome(key) {
      return readTerminal.get(key)?.outcome ?? null;
    },
    saveTerminalOutcome(key, outcome) {
      upsertTerminal.run(key, outcome);
    },
    knownLabels() {
      return new Set(Object.keys(releasedDb.meta().tags));
    },
    acceptedEntries() {
      return db
        .query<{ entry_json: string }, []>(`select entry_json from on_demand_entries order by dictionary, headword, entry_id`)
        .all()
        .map((row) => withExamples(JSON.parse(row.entry_json) as PublicLookupItem));
    },
    attemptRecords() {
      return db
        .query<{ attempt_json: string }, []>(`select attempt_json from on_demand_attempts order by id`)
        .all()
        .map((row) => JSON.parse(row.attempt_json) as AttemptRecord);
    },
    close() {
      db.close();
    }
  };
}

export function createOverlayLookupDb(
  releasedDb: LookupDb,
  repository: PersistentEnrichmentRepository
): LookupDb {
  return {
    lookup(query, requestedLang) {
      const released = releasedDb.lookup(query, requestedLang).item;
      const overlay = repository.findOverlay(query, "ja");
      if (!overlay) return { item: released };
      if (overlay.source === "generated") return { item: publicEntryForLanguage(overlay, requestedLang ?? "en") };
      if (!released || released.id !== overlay.id) return { item: released };
      const examples = new Map(overlay.senses.map((sense) => [sense.id, sense.examples]));
      return {
        item: {
          ...released,
          senses: released.senses.map((sense) => {
            const staged = examples.get(sense.id);
            return staged ? { ...sense, examples: staged } : sense;
          })
        }
      };
    },
    meta() {
      return releasedDb.meta();
    },
    close() {
      releasedDb.close();
    }
  };
}

function publicEntryForLanguage(entry: PublicLookupItem, lang: ApiLang): PublicLookupItem {
  return {
    ...entry,
    senses: entry.senses.flatMap((sense) => {
      const glosses = sense.glosses
        .filter((gloss) => !gloss.lang || gloss.lang === lang)
        .map(({ lang: _lang, ...gloss }) => gloss);
      return glosses.length > 0 ? [{ ...sense, glosses }] : [];
    })
  };
}

function ensureSchema(db: Database): void {
  db.exec(`
    create table if not exists on_demand_entries (
      entry_id text primary key,
      dictionary text not null,
      headword text not null,
      entry_json text not null,
      accepted_at text not null
    );
    create table if not exists on_demand_lookup_terms (
      dictionary text not null,
      term text not null,
      entry_id text not null,
      primary key (dictionary, term, entry_id)
    );
    create index if not exists on_demand_lookup_terms_term on on_demand_lookup_terms(dictionary, term);
    create table if not exists on_demand_senses (
      sense_id text primary key,
      entry_id text not null
    );
    create table if not exists on_demand_examples (
      sense_id text primary key,
      entry_id text not null,
      example_json text not null
    );
    create table if not exists on_demand_attempts (
      id integer primary key autoincrement,
      attempt_json text not null
    );
    create table if not exists on_demand_terminal_outcomes (
      outcome_key text primary key,
      outcome text not null
    );
  `);
  const legacyOverlay = db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name = 'example_enrichments'")
    .get();
  if (legacyOverlay) {
    db.exec(`
      insert or ignore into on_demand_examples (sense_id, entry_id, example_json)
      select sense_id, 'released:' || sense_id, example_json
        from example_enrichments
       where status = 'accepted' and example_json is not null
    `);
  }
}
