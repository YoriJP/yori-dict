import { Database } from "bun:sqlite";
import type { LookupDb } from "./db";
import type {
  AttemptRecord,
  EnrichmentRepository,
  SourceEvidence,
  TargetDictionary
} from "./on-demand-dictionary";
import type { PublicExample, PublicLookupItem, PublicSense } from "./types";

export type PersistentEnrichmentRepository = EnrichmentRepository & {
  acceptedEntries(): PublicLookupItem[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnrichmentRepository(
  path: string,
  lookupDb: LookupDb,
  sourceLookup: (query: string, targetDictionary: TargetDictionary) => SourceEvidence[] = () => []
): PersistentEnrichmentRepository {
  const db = new Database(path);
  db.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");

  const saveEntryRow = db.prepare(`
    insert into entries (id, source, source_id, headword_language, estimated_level)
    values (?, ?, ?, 'ja', ?)
    on conflict(id) do update set
      source = excluded.source,
      source_id = excluded.source_id,
      headword_language = excluded.headword_language,
      estimated_level = excluded.estimated_level
  `);
  const saveForm = db.prepare(`
    insert into forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)
  `);
  const saveLookupTerm = db.prepare(`
    insert into lookup_terms (term, entry_id, match_kind) values (?, ?, ?)
  `);
  const saveSense = db.prepare(`
    insert into senses (
      id, entry_id, position, applies_to_kanji, applies_to_kana, part_of_speech,
      misc, field, dialect, info, related, antonym, language_source
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveGloss = db.prepare(`
    insert into glosses (sense_id, lang, text, source, review_status, type)
    values (?, ?, ?, ?, ?, ?)
  `);
  const saveExampleRow = db.prepare(`
    insert into examples (
      sense_id, position, text, translations, source, source_name, source_id, review_status
    ) values (?, 1, ?, ?, 'generated', null, null, 'checked')
    on conflict(sense_id, position) do update set
      text = excluded.text,
      translations = excluded.translations,
      source = excluded.source,
      source_name = excluded.source_name,
      source_id = excluded.source_id,
      review_status = excluded.review_status
  `);
  const saveAttempt = db.prepare(`
    insert into model_attempts (dictionary, attempt_json, created_at) values ('ja', ?, ?)
  `);
  const saveGeneratedRecord = db.prepare(`
    insert into japanese_generated_records (entry_id, entry_json, accepted_at) values (?, ?, ?)
    on conflict(entry_id) do update set entry_json = excluded.entry_json, accepted_at = excluded.accepted_at
  `);
  const readTerminal = db.query<{ outcome: string }, [string]>(`
    select outcome from terminal_outcomes where dictionary = 'ja' and outcome_key = ?
  `);
  const saveTerminal = db.prepare(`
    insert into terminal_outcomes (dictionary, outcome_key, outcome) values ('ja', ?, ?)
    on conflict(dictionary, outcome_key) do update set outcome = excluded.outcome
  `);

  function find(query: string): PublicLookupItem | null {
    return lookupDb.lookup(query, "en").item;
  }

  return {
    find(query, targetDictionary) {
      return targetDictionary === "ja" ? find(query) : null;
    },
    findSources(query, targetDictionary) {
      return sourceLookup(query, targetDictionary);
    },
    saveEntry(entry) {
      db.transaction(() => {
        const senseIds = db.query<{ id: string }, [string]>("select id from senses where entry_id = ?")
          .all(entry.id).map((row) => row.id);
        for (const senseId of senseIds) {
          db.prepare("delete from glosses where sense_id = ?").run(senseId);
          db.prepare("delete from examples where sense_id = ?").run(senseId);
        }
        db.prepare("delete from senses where entry_id = ?").run(entry.id);
        db.prepare("delete from forms where entry_id = ?").run(entry.id);
        db.prepare("delete from lookup_terms where entry_id = ?").run(entry.id);

        saveEntryRow.run(entry.id, entry.source, entry.sourceId, entry.estimatedLevel ?? null);
        if (entry.source === "generated") {
          saveGeneratedRecord.run(entry.id, JSON.stringify(entry), new Date().toISOString());
        }
        for (const headword of entry.headwords) {
          saveForm.run(
            entry.id,
            headword.text,
            headword.reading,
            headword.kind,
            headword.common ? 1 : 0,
            JSON.stringify(headword.tags)
          );
          saveLookupTerm.run(headword.text, entry.id, headword.kind === "kana" ? "reading" : "kanji");
          if (headword.reading && headword.reading !== headword.text) {
            saveLookupTerm.run(headword.reading, entry.id, "reading");
          }
        }
        for (const sense of entry.senses) saveJapaneseSense(entry.id, sense);
      })();
    },
    saveExample(senseId, example) {
      saveExampleRow.run(senseId, example.text, JSON.stringify(example.translations));
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
    knownLabels() {
      return new Set(Object.keys(lookupDb.meta().tags));
    },
    acceptedEntries() {
      return db.query<{ entry_json: string }, []>(`
        select entry_json from japanese_generated_records order by entry_id
      `).all().map((row) => withCanonicalExamples(JSON.parse(row.entry_json) as PublicLookupItem));
    },
    attemptRecords() {
      return db.query<{ attempt_json: string }, []>(`
        select attempt_json from model_attempts where dictionary = 'ja' order by id
      `).all().map((row) => JSON.parse(row.attempt_json) as AttemptRecord);
    },
    close() {
      db.close();
    }
  };

  function saveJapaneseSense(entryId: string, sense: PublicSense): void {
    saveSense.run(
      sense.id,
      entryId,
      sense.position,
      JSON.stringify(sense.appliesTo.kanji),
      JSON.stringify(sense.appliesTo.kana),
      JSON.stringify(sense.partOfSpeech),
      JSON.stringify(sense.misc ?? []),
      JSON.stringify(sense.field ?? []),
      JSON.stringify(sense.dialect ?? []),
      JSON.stringify(sense.info ?? []),
      JSON.stringify(sense.related ?? []),
      JSON.stringify(sense.antonym ?? []),
      JSON.stringify(sense.languageSource ?? [])
    );
    for (const gloss of sense.glosses) {
      saveGloss.run(
        sense.id,
        gloss.lang ?? "en",
        gloss.text,
        gloss.source === "generated" ? "ai-assisted" : "jmdict",
        gloss.reviewStatus,
        gloss.type ?? null
      );
    }
    for (const example of sense.examples ?? []) {
      saveExampleRow.run(sense.id, example.text, JSON.stringify(example.translations));
    }
  }

  function withCanonicalExamples(entry: PublicLookupItem): PublicLookupItem {
    const readExamples = db.query<{
      text: string;
      translations: string;
      source: "sourced" | "generated";
      source_name: string | null;
      source_id: string | null;
      review_status: "source" | "checked";
    }, [string]>(`
      select text, translations, source, source_name, source_id, review_status
        from examples where sense_id = ? order by position
    `);
    return {
      ...entry,
      senses: entry.senses.map((sense) => ({
        ...sense,
        examples: readExamples.all(sense.id).map((example) => ({
          text: example.text,
          translations: JSON.parse(example.translations),
          source: example.source,
          ...(example.source_name ? { sourceName: example.source_name } : {}),
          ...(example.source_id ? { sourceId: example.source_id } : {}),
          reviewStatus: example.review_status
        }))
      }))
    };
  }
}
