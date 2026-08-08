import { Database } from "bun:sqlite";
import type { LookupDb } from "./db";
import { createJapaneseSchema } from "./japanese-schema";
import { apiLanguages } from "./lang";
import type {
  AttemptRecord,
  EnrichmentRepository,
  GenerationProvenance,
  LabelVocabulary,
  SourceEvidence,
  TargetDictionary
} from "./on-demand-dictionary";
import type { ApiLang, PublicExample, PublicLookupItem, PublicSense } from "./types";

export type PersistentEnrichmentRepository = EnrichmentRepository & {
  acceptedEntries(lang: ApiLang): PublicLookupItem[];
  attemptRecords(): AttemptRecord[];
  close(): void;
};

export function openEnrichmentRepository(
  path: string,
  lookupDb: LookupDb,
  sourceLookup: (query: string, targetDictionary: TargetDictionary) => SourceEvidence[] = () => []
): PersistentEnrichmentRepository {
  const db = new Database(path);
  let vocabulary: LabelVocabulary | undefined;
  db.exec("pragma journal_mode = WAL; pragma synchronous = NORMAL; pragma busy_timeout = 5000;");
  createJapaneseSchema(db);

  // An authored language group never rewrites an imported entry's identity:
  // the update only applies to an entry this dictionary itself generated.
  const saveEntryRow = db.prepare(`
    insert into ja_entries (id, source, source_id, headword_language, estimated_level)
    values (?, ?, ?, 'ja', ?)
    on conflict(id) do update set
      source = excluded.source,
      source_id = excluded.source_id,
      estimated_level = excluded.estimated_level
    where ja_entries.source = 'generated'
  `);
  const saveForm = db.prepare(`
    insert or replace into ja_forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)
  `);
  const saveLookupTerm = db.prepare(`
    insert or ignore into ja_lookup_terms (term, entry_id, match_kind) values (?, ?, ?)
  `);
  const saveSense = db.prepare(`
    insert into ja_senses (
      id, entry_id, lang, position, applies_to_kanji, applies_to_kana, part_of_speech,
      misc, field, dialect, info, related, antonym, language_source,
      pronunciations, pragmatic_functions, provenance, source_name, source_version, source_ref, generation_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveGloss = db.prepare(`
    insert into ja_glosses (sense_id, position, text, source, review_status, type)
    values (?, ?, ?, ?, ?, ?)
  `);
  const clearGeneratedExamples = db.prepare(
    "delete from ja_examples where sense_id = ? and source = 'generated'"
  );
  // A generated example is appended after the meaning's imported examples, so
  // accepting or retrying one never overwrites sourced content.
  const insertGeneratedExample = db.prepare(`
    insert into ja_examples (
      sense_id, position, text, translations, source, source_name, source_id, review_status, generation_id
    ) values (
      ?,
      (select coalesce(max(position), 0) + 1 from ja_examples where sense_id = ?),
      ?, ?, 'generated', null, null, 'checked', ?
    )
  `);
  const appendExample = (
    senseId: string,
    text: string,
    translations: string,
    generationRef: string | null
  ) => insertGeneratedExample.run(senseId, senseId, text, translations, generationRef);
  /** One accepted generated example per meaning: a retry replaces the previous one. */
  const saveExampleRow = (
    senseId: string,
    text: string,
    translations: string,
    generationRef: string | null
  ) => {
    clearGeneratedExamples.run(senseId);
    appendExample(senseId, text, translations, generationRef);
  };
  const saveGeneration = db.prepare(`
    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set review_outcome = excluded.review_outcome
  `);
  const saveAttempt = db.prepare(`
    insert into model_attempts (dictionary, attempt_json, created_at) values ('ja', ?, ?)
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
    find(query, targetDictionary, lang) {
      return targetDictionary === "ja" ? lookupDb.lookup(query, lang).item : null;
    },
    findSources(query, targetDictionary) {
      return sourceLookup(query, targetDictionary);
    },
    /**
     * Writes one entry-language group atomically. Only meanings in `lang` are
     * replaced, so authoring or rejecting one language never disturbs another
     * language's accepted content for the same entry.
     */
    saveEntry(entry, lang, generation) {
      db.transaction(() => {
        const generationRef = recordGeneration(generation);
        const senseIds = db.query<{ id: string }, [string, string]>(
          "select id from ja_senses where entry_id = ? and lang = ?"
        ).all(entry.id, lang).map((row) => row.id);
        for (const senseId of senseIds) {
          db.prepare("delete from ja_glosses where sense_id = ?").run(senseId);
          db.prepare("delete from ja_examples where sense_id = ?").run(senseId);
        }
        db.prepare("delete from ja_senses where entry_id = ? and lang = ?").run(entry.id, lang);

        const imported = db.query<{ source: string }, [string]>(
          "select source from ja_entries where id = ?"
        ).get(entry.id)?.source === "jmdict";
        saveEntryRow.run(entry.id, entry.source, entry.sourceId, entry.estimatedLevel ?? null);
        // Written forms belong to the entry, not to one explanation language.
        // An imported entry keeps the ones its source wrote.
        for (const headword of imported ? [] : entry.headwords) {
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
        entry.senses.forEach((sense, index) => {
          saveJapaneseSense(entry.id, lang, sense, index + 1, generationRef);
        });
      })();
    },
    saveExample(senseId, example, generation) {
      db.transaction(() => {
        saveExampleRow(
          senseId,
          example.text,
          JSON.stringify(example.translations),
          recordGeneration(generation)
        );
      })();
    },
    recordAttempt(attempt) {
      saveAttempt.run(JSON.stringify(attempt), new Date().toISOString());
    },
    labelVocabulary() {
      return vocabulary ??= readLabelVocabulary(db);
    },
    canonicalEntry(query) {
      for (const lang of apiLanguages) {
        const item = lookupDb.lookup(query, lang).item;
        if (item) return { id: item.id, headword: item.word };
      }
      return null;
    },
    acceptedEntries(lang) {
      return db.query<{ id: string }, [string]>(`
        select distinct entry.id as id from ja_entries entry
          join ja_senses sense on sense.entry_id = entry.id
         where entry.source = 'generated' and sense.lang = ?
         order by entry.id
      `).all(lang).flatMap((row) => {
        const forms = db.query<{ text: string }, [string]>(
          "select text from ja_forms where entry_id = ? order by common desc, text limit 1"
        ).get(row.id);
        const item = forms ? lookupDb.lookup(forms.text, lang).item : null;
        return item ? [item] : [];
      });
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

  function saveJapaneseSense(
    entryId: string,
    lang: ApiLang,
    sense: PublicSense,
    position: number,
    generationRef: string | null
  ): void {
    const provenance = sense.provenance ?? "generated";
    saveSense.run(
      sense.id,
      entryId,
      lang,
      position,
      JSON.stringify(sense.appliesTo.kanji),
      JSON.stringify(sense.appliesTo.kana),
      JSON.stringify(sense.partOfSpeech),
      JSON.stringify(sense.misc ?? []),
      JSON.stringify(sense.field ?? []),
      JSON.stringify(sense.dialect ?? []),
      JSON.stringify(sense.info ?? []),
      JSON.stringify(sense.related ?? []),
      JSON.stringify(sense.antonym ?? []),
      JSON.stringify(sense.languageSource ?? []),
      JSON.stringify(sense.pronunciations ?? []),
      JSON.stringify(sense.pragmaticFunctions ?? []),
      provenance,
      provenance === "generated" ? "generated" : sense.evidenceIds?.[0]?.split(":")[0] ?? "source",
      null,
      sense.evidenceIds?.[0] ?? null,
      generationRef
    );
    sense.glosses.forEach((gloss, index) => {
      saveGloss.run(
        sense.id,
        index + 1,
        gloss.text,
        gloss.source === "jmdict" ? "jmdict" : "generated",
        gloss.reviewStatus,
        gloss.type ?? null
      );
    });
    // The meaning was just rewritten, so its examples are appended in the order
    // they arrived rather than competing for one fixed position.
    (sense.examples ?? []).forEach((example) => {
      appendExample(sense.id, example.text, JSON.stringify(example.translations), generationRef);
    });
  }
}

/**
 * One row per generation run. The creation time is part of the identity, so
 * two runs of the same model and prompt keep their own timestamps instead of
 * collapsing onto the first run's provenance.
 */
function generationId(generation: GenerationProvenance): string {
  return [
    generation.provider,
    generation.model,
    generation.promptVersion,
    generation.reasoningEffort,
    generation.serviceTier ?? "unset",
    generation.createdAt
  ].join("|");
}

/**
 * The label codes an authored sense may use, read from the codes the imported
 * dictionary already uses. Reading them from the data rather than a hand-kept
 * list means a code JMdict adds becomes available without a code change, and
 * the author schema can never offer a code the dictionary does not use.
 */
function readLabelVocabulary(db: Database): LabelVocabulary {
  const codes = (column: string): Set<string> => {
    const found = new Set<string>();
    for (const row of db.query<{ value: string }, []>(`select distinct ${column} as value from ja_senses`).all()) {
      try {
        for (const code of JSON.parse(row.value) as unknown[]) {
          if (typeof code === "string" && code) found.add(code);
        }
      } catch {
        // A sense that does not hold a JSON array contributes no codes.
      }
    }
    return found;
  };
  return {
    partOfSpeech: codes("part_of_speech"),
    misc: codes("misc"),
    field: codes("field"),
    dialect: codes("dialect")
  };
}
