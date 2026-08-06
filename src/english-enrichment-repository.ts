import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptRecord, EnglishEnrichmentRepository } from "./on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "./english-types";

export type PersistentEnglishEnrichmentRepository = EnglishEnrichmentRepository & {
  acceptedEntries(): EnglishEntry[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnglishEnrichmentRepository(
  overlayPath: string,
  releasePath: string
): PersistentEnglishEnrichmentRepository {
  mkdirSync(dirname(overlayPath), { recursive: true });
  const overlay = new Database(overlayPath, { create: true });
  const released = new Database(releasePath, { readonly: true });
  ensureEnglishOverlaySchema(overlay);
  const releasedEntry = released.query<{ entry_json: string }, [string]>(
    "select entry_json from entries where lookup_term = ? limit 1"
  );
  const releasedSources = released.query<{ record_json: string; raw_json: string }, [string]>(
    `select r.record_json, p.raw_json
       from source_records r
       join source_payloads p on p.source = r.source and p.payload_id = r.payload_id
      where r.headword_lookup = ?
      order by r.source, r.source_entry_id`
  );
  const overlayEntry = overlay.query<{ entry_json: string }, [string]>(
    "select entry_json from english_entries where headword_lookup = ? limit 1"
  );
  const overlayExamples = overlay.query<{ sense_id: string; example_json: string }, [string]>(
    "select sense_id, example_json from english_examples where entry_id = ? order by sense_id"
  );
  const saveEntry = overlay.prepare(
    `insert into english_entries (entry_id, headword_lookup, entry_json, accepted_at) values (?, ?, ?, ?)
     on conflict(entry_id) do update set headword_lookup = excluded.headword_lookup, entry_json = excluded.entry_json`
  );
  const saveSense = overlay.prepare(
    `insert into english_senses (sense_id, entry_id) values (?, ?)
     on conflict(sense_id) do update set entry_id = excluded.entry_id`
  );
  const entryForSense = overlay.query<{ entry_id: string }, [string]>(
    "select entry_id from english_senses where sense_id = ?"
  );
  const saveExample = overlay.prepare(
    `insert into english_examples (sense_id, entry_id, example_json) values (?, ?, ?)
     on conflict(sense_id) do update set entry_id = excluded.entry_id, example_json = excluded.example_json`
  );
  const saveAttempt = overlay.prepare("insert into english_attempts (attempt_json) values (?)");
  const terminal = overlay.query<{ outcome: string }, [string]>(
    "select outcome from english_terminal_outcomes where outcome_key = ?"
  );
  const saveTerminal = overlay.prepare(
    `insert into english_terminal_outcomes (outcome_key, outcome) values (?, ?)
     on conflict(outcome_key) do update set outcome = excluded.outcome`
  );

  function withExamples(entry: EnglishEntry): EnglishEntry {
    const examples = new Map(overlayExamples.all(entry.id).map((row) => [
      row.sense_id,
      JSON.parse(row.example_json) as EnglishExample
    ]));
    return {
      ...entry,
      senses: entry.senses.map((sense) => examples.has(sense.id)
        ? { ...sense, examples: [examples.get(sense.id)!] }
        : sense)
    };
  }

  return {
    findReleased(query) {
      const row = releasedEntry.get(normalize(query));
      return row ? JSON.parse(row.entry_json) as EnglishEntry : null;
    },
    findOverlay(query) {
      const row = overlayEntry.get(normalize(query));
      return row ? withExamples(JSON.parse(row.entry_json) as EnglishEntry) : null;
    },
    findSources(query) {
      return releasedSources.all(normalize(query)).map((row) => ({
        ...(JSON.parse(row.record_json) as EnglishSourceRecord),
        rawRecord: JSON.parse(row.raw_json)
      }));
    },
    saveEntry(entry) {
      overlay.transaction(() => {
        saveEntry.run(entry.id, normalize(entry.headword), JSON.stringify(entry), new Date().toISOString());
        for (const sense of entry.senses) saveSense.run(sense.id, entry.id);
      })();
    },
    saveExample(senseId, example) {
      const entryId = entryForSense.get(senseId)?.entry_id;
      if (!entryId) throw new Error(`Cannot save an English example before its entry: ${senseId}`);
      saveExample.run(senseId, entryId, JSON.stringify(example));
    },
    recordAttempt(attempt) { saveAttempt.run(JSON.stringify(attempt)); },
    terminalOutcome(key) { return terminal.get(key)?.outcome ?? null; },
    saveTerminalOutcome(key, outcome) { saveTerminal.run(key, outcome); },
    acceptedEntries() {
      return overlay.query<{ entry_json: string }, []>(
        "select entry_json from english_entries order by headword_lookup, entry_id"
      ).all().map((row) => withExamples(JSON.parse(row.entry_json) as EnglishEntry));
    },
    attemptRecords() {
      return overlay.query<{ attempt_json: string }, []>(
        "select attempt_json from english_attempts order by id"
      ).all().map((row) => JSON.parse(row.attempt_json) as AttemptRecord);
    },
    close() {
      released.close();
      overlay.close();
    }
  };
}

function ensureEnglishOverlaySchema(db: Database): void {
  db.exec(`
    create table if not exists english_entries (
      entry_id text primary key,
      headword_lookup text not null unique,
      entry_json text not null,
      accepted_at text not null
    );
    create table if not exists english_senses (
      sense_id text primary key,
      entry_id text not null
    );
    create table if not exists english_examples (
      sense_id text primary key,
      entry_id text not null,
      example_json text not null
    );
    create table if not exists english_attempts (
      id integer primary key autoincrement,
      attempt_json text not null
    );
    create table if not exists english_terminal_outcomes (
      outcome_key text primary key,
      outcome text not null
    );
  `);
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
