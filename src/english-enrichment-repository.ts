import { Database } from "bun:sqlite";
import type { AttemptRecord, EnglishEnrichmentRepository } from "./on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "./english-types";

export type PersistentEnglishEnrichmentRepository = EnglishEnrichmentRepository & {
  acceptedEntries(): EnglishEntry[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnglishEnrichmentRepository(path: string): PersistentEnglishEnrichmentRepository {
  const db = new Database(path);
  db.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");

  const readEntry = db.query<{ entry_json: string }, [string]>(
    "select entry_json from english_entries where lookup_term = ? limit 1"
  );
  const readSources = db.query<{ record_json: string; raw_json: string }, [string]>(`
    select r.record_json, p.raw_json
      from english_source_records r
      join english_source_payloads p on p.source = r.source and p.payload_id = r.payload_id
     where r.headword_lookup = ?
     order by r.source, r.source_entry_id
  `);
  const readExamples = db.query<{ sense_id: string; example_json: string }, [string]>(
    "select sense_id, example_json from english_examples where entry_id = ? order by sense_id"
  );
  const saveEntryRow = db.prepare(`
    insert into english_entries (id, headword, lookup_term, entry_json) values (?, ?, ?, ?)
    on conflict(id) do update set
      headword = excluded.headword,
      lookup_term = excluded.lookup_term,
      entry_json = excluded.entry_json
  `);
  const saveSense = db.prepare(`
    insert into english_senses (id, entry_id, position, part_of_speech, definition, sense_json)
    values (?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      entry_id = excluded.entry_id,
      position = excluded.position,
      part_of_speech = excluded.part_of_speech,
      definition = excluded.definition,
      sense_json = excluded.sense_json
  `);
  const entryForSense = db.query<{ entry_id: string }, [string]>(
    "select entry_id from english_senses where id = ?"
  );
  const saveExampleRow = db.prepare(`
    insert into english_examples (sense_id, entry_id, example_json) values (?, ?, ?)
    on conflict(sense_id) do update set entry_id = excluded.entry_id, example_json = excluded.example_json
  `);
  const saveAttempt = db.prepare(`
    insert into model_attempts (dictionary, attempt_json, created_at) values ('en', ?, ?)
  `);
  const readTerminal = db.query<{ outcome: string }, [string]>(`
    select outcome from terminal_outcomes where dictionary = 'en' and outcome_key = ?
  `);
  const saveTerminal = db.prepare(`
    insert into terminal_outcomes (dictionary, outcome_key, outcome) values ('en', ?, ?)
    on conflict(dictionary, outcome_key) do update set outcome = excluded.outcome
  `);

  function withExamples(entry: EnglishEntry): EnglishEntry {
    const examples = new Map(readExamples.all(entry.id).map((row) => [
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

  function find(query: string): EnglishEntry | null {
    const row = readEntry.get(normalize(query));
    return row ? withExamples(JSON.parse(row.entry_json) as EnglishEntry) : null;
  }

  return {
    find,
    findSources(query) {
      return readSources.all(normalize(query)).map((row) => ({
        ...(JSON.parse(row.record_json) as EnglishSourceRecord),
        rawRecord: JSON.parse(row.raw_json)
      }));
    },
    saveEntry(entry) {
      db.transaction(() => {
        saveEntryRow.run(entry.id, entry.headword, normalize(entry.headword), JSON.stringify(entry));
        const retained = new Set(entry.senses.map((sense) => sense.id));
        for (const row of db.query<{ id: string }, [string]>("select id from english_senses where entry_id = ?").all(entry.id)) {
          if (!retained.has(row.id)) {
            db.prepare("delete from english_examples where sense_id = ?").run(row.id);
            db.prepare("delete from english_senses where id = ?").run(row.id);
          }
        }
        for (const sense of entry.senses) {
          saveSense.run(
            sense.id,
            entry.id,
            sense.position,
            sense.partOfSpeech,
            sense.definition,
            JSON.stringify(sense)
          );
          for (const example of sense.examples) saveExampleRow.run(sense.id, entry.id, JSON.stringify(example));
        }
      })();
    },
    saveExample(senseId, example) {
      const entryId = entryForSense.get(senseId)?.entry_id;
      if (!entryId) throw new Error(`Cannot save an English example before its entry: ${senseId}`);
      saveExampleRow.run(senseId, entryId, JSON.stringify(example));
    },
    recordAttempt(attempt) {
      saveAttempt.run(JSON.stringify(attempt), new Date().toISOString());
    },
    terminalOutcome(key) {
      return readTerminal.get(key)?.outcome ?? null;
    },
    saveTerminalOutcome(key, outcome) {
      saveTerminal.run(key, outcome);
    },
    acceptedEntries() {
      return db.query<{ entry_json: string }, []>(
        "select entry_json from english_entries order by lookup_term, id"
      ).all().map((row) => withExamples(JSON.parse(row.entry_json) as EnglishEntry))
        .filter((entry) => entry.senses.some((sense) => sense.generation));
    },
    attemptRecords() {
      return db.query<{ attempt_json: string }, []>(`
        select attempt_json from model_attempts where dictionary = 'en' order by id
      `).all().map((row) => JSON.parse(row.attempt_json) as AttemptRecord);
    },
    close() {
      db.close();
    }
  };
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
