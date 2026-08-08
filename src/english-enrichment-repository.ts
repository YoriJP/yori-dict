import { Database } from "bun:sqlite";
import {
  lookupEnglishEntry,
  normalizeEnglishLookupTerm,
  readEnglishEntry
} from "./english-dictionary";
import { createEnglishSchema } from "./english-schema";
import type { AttemptRecord, EnglishEnrichmentRepository, GenerationProvenance } from "./on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "./english-types";
import type { ApiLang } from "./types";

export type PersistentEnglishEnrichmentRepository = EnglishEnrichmentRepository & {
  acceptedEntries(lang: ApiLang): EnglishEntry[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnglishEnrichmentRepository(path: string): PersistentEnglishEnrichmentRepository {
  const db = new Database(path);
  db.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  createEnglishSchema(db);

  const saveEntryRow = db.prepare(`
    insert into en_entries (id, source, source_id, headword, lookup_term, headword_language)
    values (?, ?, ?, ?, ?, 'en')
    on conflict(id) do update set headword = excluded.headword
  `);
  const saveEntrySource = db.prepare(`
    insert or ignore into en_entry_sources
      (entry_id, source, source_version, source_entry_id, license, attribution)
    values (?, ?, ?, ?, ?, ?)
  `);
  const savePronunciation = db.prepare(`
    insert or replace into en_pronunciations
      (entry_id, position, ipa, region, source_name, source_version, source_ref)
    values (?, ?, ?, ?, ?, null, ?)
  `);
  const saveLookupTerm = db.prepare("insert or ignore into en_lookup_terms (term, entry_id) values (?, ?)");
  const saveSense = db.prepare(`
    insert into en_senses (
      id, entry_id, lang, position, part_of_speech, registers, regions, domains, dated, usage,
      provenance, source_name, source_version, source_ref, generation_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveGloss = db.prepare(`
    insert into en_glosses (sense_id, position, text, source, review_status, type) values (?, ?, ?, ?, ?, ?)
  `);
  const clearGeneratedExamples = db.prepare(
    "delete from en_examples where sense_id = ? and source = 'generated'"
  );
  // A generated example is appended after the meaning's imported examples, so
  // accepting or retrying one never overwrites sourced content.
  const insertGeneratedExample = db.prepare(`
    insert into en_examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status, generation_id)
    values (?, (select coalesce(max(position), 0) + 1 from en_examples where sense_id = ?), ?, ?, 'generated', null, null, 'checked', ?)
  `);
  const saveExampleRow = (senseId: string, text: string, translations: string, generationRef: string | null) => {
    clearGeneratedExamples.run(senseId);
    insertGeneratedExample.run(senseId, senseId, text, translations, generationRef);
  };
  const saveGeneration = db.prepare(`
    insert into en_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set review_outcome = excluded.review_outcome
  `);
  const saveAttempt = db.prepare(
    "insert into model_attempts (dictionary, attempt_json, created_at) values ('en', ?, ?)"
  );
  const readTerminal = db.query<{ outcome: string }, [string]>(
    "select outcome from terminal_outcomes where dictionary = 'en' and outcome_key = ?"
  );
  const saveTerminal = db.prepare(`
    insert into terminal_outcomes (dictionary, outcome_key, outcome) values ('en', ?, ?)
    on conflict(dictionary, outcome_key) do update set outcome = excluded.outcome
  `);

  function recordGeneration(generation: GenerationProvenance | undefined): string | null {
    if (!generation) return null;
    const id = generationId(generation);
    saveGeneration.run(
      id,
      generation.model,
      generation.provider,
      generation.reasoningEffort,
      generation.promptVersion,
      generation.serviceTier ?? null,
      generation.reviewOutcome,
      generation.createdAt
    );
    return id;
  }

  return {
    find(query, lang) {
      return lookupEnglishEntry(db, query, lang);
    },
    /**
     * Concise canonical evidence for this headword: one record per contributing
     * source with its selected text and stable evidence identifiers. Complete
     * raw source payloads stay in the rebuild inputs and never reach a model.
     */
    findSources(query) {
      const term = normalizeEnglishLookupTerm(query);
      const entry = db.query<{ id: string }, [string]>(
        "select entry_id as id from en_lookup_terms where term = ? order by entry_id limit 1"
      ).get(term);
      if (!entry) return [];
      const sources = db.query<
        { source: string; source_version: string; source_entry_id: string; license: string; attribution: string },
        [string]
      >("select * from en_entry_sources where entry_id = ? order by source, source_entry_id").all(entry.id);
      const headword = db.query<{ headword: string }, [string]>(
        "select headword from en_entries where id = ?"
      ).get(entry.id)?.headword ?? term;
      return sources.flatMap((source): EnglishSourceRecord[] => {
        const senses = db.query<
          {
            id: string;
            part_of_speech: string;
            registers: string;
            regions: string;
            domains: string;
            dated: number;
            usage: string;
            source_ref: string | null;
          },
          [string, string]
        >(`select * from en_senses where entry_id = ? and source_name = ? order by lang, position`)
          .all(entry.id, source.source)
          .flatMap((sense) => sense.source_ref ? [{
            evidenceId: sense.source_ref,
            partOfSpeech: sense.part_of_speech,
            glosses: db.query<{ text: string }, [string]>(
              "select text from en_glosses where sense_id = ? order by position"
            ).all(sense.id).map((row) => row.text),
            registers: JSON.parse(sense.registers) as string[],
            regions: JSON.parse(sense.regions) as string[],
            domains: JSON.parse(sense.domains) as string[],
            dated: sense.dated === 1,
            usage: JSON.parse(sense.usage) as string[],
            examples: [] as EnglishExample[]
          }] : []);
        if (senses.length === 0) return [];
        return [{
          source: source.source as EnglishSourceRecord["source"],
          sourceVersion: source.source_version,
          sourceEntryId: source.source_entry_id,
          license: source.license,
          attribution: source.attribution,
          headword,
          pronunciations: db.query<{ ipa: string; region: string | null; source_ref: string | null }, [string, string]>(
            "select ipa, region, source_ref from en_pronunciations where entry_id = ? and source_name = ? order by position"
          ).all(entry.id, source.source).flatMap((row) => row.source_ref ? [{
            ipa: row.ipa,
            ...(row.region ? { region: row.region } : {}),
            evidenceId: row.source_ref
          }] : []),
          senses
        }];
      });
    },
    /**
     * Writes one entry-language group atomically. Only meanings in `lang` are
     * replaced, so authoring or rejecting one language never disturbs another
     * language's accepted content for the same entry, and imported meanings in
     * another language are never rewritten.
     */
    saveEntry(entry, lang, generation) {
      db.transaction(() => {
        const generationRef = recordGeneration(generation);
        const entryId = entry.id;
        const lookupTerm = normalizeEnglishLookupTerm(entry.headword);
        const senseIds = db.query<{ id: string }, [string, string]>(
          "select id from en_senses where entry_id = ? and lang = ?"
        ).all(entryId, lang).map((row) => row.id);
        for (const senseId of senseIds) {
          db.prepare("delete from en_glosses where sense_id = ?").run(senseId);
          db.prepare("delete from en_examples where sense_id = ?").run(senseId);
        }
        db.prepare("delete from en_senses where entry_id = ? and lang = ?").run(entryId, lang);

        saveEntryRow.run(entryId, entrySource(entry), entryId, entry.headword, lookupTerm);
        saveLookupTerm.run(lookupTerm, entryId);
        for (const source of entry.sources) {
          saveEntrySource.run(
            entryId,
            source.source,
            source.sourceVersion,
            source.sourceEntryId,
            source.license,
            source.attribution
          );
        }
        entry.pronunciations.forEach((pronunciation, index) => {
          savePronunciation.run(
            entryId,
            index + 1,
            pronunciation.ipa,
            pronunciation.region ?? null,
            pronunciation.source,
            pronunciation.sourceRef ?? null
          );
        });
        entry.senses.forEach((sense, index) => {
          saveSense.run(
            sense.id,
            entryId,
            lang,
            index + 1,
            sense.partOfSpeech,
            JSON.stringify(sense.registers),
            JSON.stringify(sense.regions),
            JSON.stringify(sense.domains),
            sense.dated ? 1 : 0,
            JSON.stringify(sense.usage),
            sense.provenance,
            sense.source?.name ?? (sense.provenance === "generated" ? "generated" : sourceName(sense.evidenceIds)),
            sense.source?.version ?? null,
            sense.evidenceIds[0] ?? null,
            sense.provenance === "generated" ? generationRef : null
          );
          sense.glosses.forEach((gloss, glossIndex) => {
            saveGloss.run(sense.id, glossIndex + 1, gloss.text, gloss.source, gloss.reviewStatus, gloss.type ?? null);
          });
          for (const example of sense.examples) {
            if (example.source !== "generated") continue;
            saveExampleRow(
              sense.id,
              example.text,
              JSON.stringify(example.translations ?? []),
              generationRef
            );
          }
        });
      })();
    },
    saveExample(senseId, example, generation) {
      db.transaction(() => {
        if (!db.query<{ id: string }, [string]>("select id from en_senses where id = ?").get(senseId)) {
          throw new Error(`Cannot save an English example before its meaning: ${senseId}`);
        }
        saveExampleRow(
          senseId,
          example.text,
          JSON.stringify(example.translations ?? []),
          recordGeneration(generation)
        );
      })();
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
    acceptedEntries(lang) {
      return db.query<{ id: string }, [string]>(`
        select distinct entry.id as id from en_entries entry
          join en_senses sense on sense.entry_id = entry.id
         where entry.source = 'generated' and sense.lang = ?
         order by entry.lookup_term, entry.id
      `).all(lang).flatMap((row) => {
        const entry = readEnglishEntry(db, row.id, lang);
        return entry ? [entry] : [];
      });
    },
    attemptRecords() {
      return db.query<{ attempt_json: string }, []>(
        "select attempt_json from model_attempts where dictionary = 'en' order by id"
      ).all().map((row) => JSON.parse(row.attempt_json) as AttemptRecord);
    },
    close() {
      db.close();
    }
  };
}

function entrySource(entry: EnglishEntry): string {
  const imported = entry.sources[0]?.source;
  return imported === "open-english-wordnet" || imported === "wiktionary" ? imported : "generated";
}

function sourceName(evidenceIds: string[]): string {
  return evidenceIds[0]?.split(":")[0] ?? "source";
}

function generationId(generation: GenerationProvenance): string {
  return [
    generation.provider,
    generation.model,
    generation.promptVersion,
    generation.reasoningEffort,
    generation.serviceTier ?? "unset"
  ].join("|");
}
