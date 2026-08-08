import { Database } from "bun:sqlite";
import { insertRow, removeDatabaseFiles } from "./canonical-store";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createJapaneseSchema,
  hasJapaneseSchema,
  japaneseSchemaVersion,
  readCoverage,
  type LanguageCoverage
} from "./japanese-schema";
import { parseApiLang, toApiLang } from "./lang";
import type { ApiLang, EstimatedLevel, JmdictFile, JmdictWord } from "./types";

export type JapaneseRebuildOptions = {
  /** Pinned JMdict-simplified export. */
  input: string;
  out: string;
  examples?: string | null;
  jlptVocab?: string | null;
  /** Legacy accepted gloss records keyed by an exact imported sense identifier. */
  aiGlosses?: string[];
  aiExamples?: string[];
  /**
   * Database whose accepted generated content is carried into the rebuild.
   * Defaults to the output path, so an ordinary rebuild keeps its own
   * accepted enrichment.
   */
  retainFrom?: string | null;
};

export type JapaneseRebuildResult = {
  path: string;
  entries: number;
  coverage: Record<string, LanguageCoverage>;
  sourcedExamples: { imported: number; unmatched: number; ambiguous: number; invalid: number };
  legacyGlosses: { imported: number; droppedUnknownSense: number };
  legacyExamples: { imported: number; droppedUnknownSense: number };
  retained: { entries: number; groups: number; examples: number };
};

type LegacyGlossRow = {
  senseId: string;
  lang: string;
  glosses: string[];
  source?: string;
  model?: string;
};

type LegacyExampleRow = {
  senseId: string;
  example: {
    text: string;
    translations: Array<{ lang: string; text: string }>;
    source: "generated";
    reviewStatus: "checked";
  };
  attempts: unknown[];
};

/**
 * One accepted authored language group on an entry the sources still provide.
 * The entry itself is imported, so only this language's own meanings, glosses,
 * examples, and generation provenance are carried across a rebuild.
 */
type RetainedGroup = {
  entryId: string;
  lang: string;
  senses: Array<Record<string, unknown>>;
  glosses: Array<Record<string, unknown>>;
  examples: Array<Record<string, unknown>>;
  generations: Array<Record<string, unknown>>;
};

type Retained = {
  entries: RetainedEntry[];
  groups: RetainedGroup[];
  examples: Array<Record<string, unknown>>;
  /** Generations referenced by retained examples on imported meanings. */
  exampleGenerations: Array<Record<string, unknown>>;
};

type RetainedEntry = {
  entry: {
    id: string;
    source: string;
    sourceId: string;
    headwordLanguage: string;
    estimatedLevel: string | null;
  };
  forms: Array<Record<string, unknown>>;
  lookupTerms: Array<Record<string, unknown>>;
  senses: Array<Record<string, unknown>>;
  glosses: Array<Record<string, unknown>>;
  examples: Array<Record<string, unknown>>;
  generations: Array<Record<string, unknown>>;
};

/**
 * Rebuilds the whole Japanese dictionary from pinned inputs into a fresh file
 * and only then replaces the previous database. A failed rebuild throws with
 * the previous file untouched.
 */
export async function rebuildJapaneseDictionary(
  options: JapaneseRebuildOptions
): Promise<JapaneseRebuildResult> {
  const out = resolve(options.out);
  const staging = `${out}.rebuild-${process.pid}-${Date.now()}.tmp`;
  await mkdir(dirname(out), { recursive: true });
  await removeDatabaseFiles(staging);

  const retainFrom = options.retainFrom === undefined ? out : options.retainFrom;
  const retained = retainFrom && existsSync(retainFrom) ? readRetained(retainFrom) : emptyRetained();

  const db = new Database(staging, { create: true });
  try {
    const result = await buildInto(db, options, retained);
    db.close();
    await removeDatabaseFiles(out);
    await rename(staging, out);
    return { ...result, path: out };
  } catch (error) {
    try {
      db.close();
    } catch {
      // The staging database is discarded either way.
    }
    await removeDatabaseFiles(staging);
    throw error;
  }
}

async function buildInto(
  db: Database,
  options: JapaneseRebuildOptions,
  retained: Retained
): Promise<Omit<JapaneseRebuildResult, "path">> {
  db.exec("pragma journal_mode = OFF; pragma synchronous = OFF;");
  createJapaneseSchema(db);

  const source = (await Bun.file(options.input).json()) as JmdictFile;
  const exampleSource = options.examples
    ? ((await Bun.file(options.examples).json()) as JmdictFile)
    : null;
  if (exampleSource && source.version !== exampleSource.version) {
    throw new Error(
      `JMdict example version ${exampleSource.version ?? "unknown"} does not match dictionary version ${source.version ?? "unknown"}`
    );
  }
  const estimatedLevels = options.jlptVocab
    ? await readEstimatedLevels(options.jlptVocab)
    : new Map<string, EstimatedLevel>();
  const legacyGlosses = (await Promise.all((options.aiGlosses ?? []).map((path) => readJsonl<LegacyGlossRow>(path)))).flat();
  const legacyExamples = (await Promise.all((options.aiExamples ?? []).map((path) => readJsonl<LegacyExampleRow>(path)))).flat();

  writeMetadata(db, source);
  const importResult = importWords(db, source, exampleSource, estimatedLevels);
  const glossResult = importLegacyGlosses(db, legacyGlosses, importResult.importedSenses, source.version ?? "unknown");
  const exampleResult = importLegacyExamples(db, legacyExamples, importResult.importedSenses);
  const retainedResult = restoreRetained(db, retained);

  return {
    entries: db.query<{ count: number }, []>("select count(*) as count from ja_entries").get()?.count ?? 0,
    coverage: readCoverage(db),
    sourcedExamples: importResult.exampleStats,
    legacyGlosses: glossResult,
    legacyExamples: exampleResult,
    retained: retainedResult
  };
}

function writeMetadata(db: Database, source: JmdictFile): void {
  const insert = db.prepare("insert or replace into ja_metadata (key, value) values (?, ?)");
  insert.run("schemaVersion", japaneseSchemaVersion);
  if (source.version) insert.run("jmdictSimplifiedVersion", source.version);
  if (source.dictDate) insert.run("dictDate", source.dictDate);
  if (source.languages) insert.run("sourceLanguages", JSON.stringify(source.languages));
  if (source.tags) insert.run("tags", JSON.stringify(source.tags));
}

type ImportedSense = {
  entryId: string;
  jmdictSense: JmdictWord["sense"][number];
  position: number;
  /** Language-scoped canonical sense ids created for this source meaning. */
  byLang: Map<ApiLang, string>;
};

function importWords(
  db: Database,
  source: JmdictFile,
  exampleSource: JmdictFile | null,
  estimatedLevels: Map<string, EstimatedLevel>
) {
  const exampleStats = { imported: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
  const importedSenses = new Map<string, ImportedSense>();
  const sourceVersion = source.version ?? "unknown";

  const insertEntry = db.prepare(
    "insert into ja_entries (id, source, source_id, headword_language, estimated_level) values (?, 'jmdict', ?, 'ja', ?)"
  );
  const insertForm = db.prepare(
    "insert or ignore into ja_forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)"
  );
  const insertLookup = db.prepare(
    "insert or ignore into ja_lookup_terms (term, entry_id, match_kind) values (?, ?, ?)"
  );
  const insertSense = insertSenseStatement(db);
  const insertGloss = db.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status, type) values (?, ?, ?, 'jmdict', 'source', ?)"
  );
  const insertExample = db.prepare(`
    insert or ignore into ja_examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status)
    values (?, ?, ?, ?, 'sourced', ?, ?, 'source')
  `);

  const examplesBySourceId = new Map((exampleSource?.words ?? []).map((word) => [word.id, word]));
  const wordSourceIds = new Set(source.words.map((word) => word.id));
  for (const exampleWord of exampleSource?.words ?? []) {
    if (!wordSourceIds.has(exampleWord.id)) exampleStats.unmatched += countExamples(exampleWord);
  }

  db.transaction((words: JmdictWord[]) => {
    for (const word of words) {
      const entryId = `yori:e_jmdict_${word.id}`;
      insertEntry.run(entryId, word.id, estimatedLevels.get(word.id) ?? null);

      for (const kanji of word.kanji) {
        insertForm.run(entryId, kanji.text, readingForKanji(word, kanji.text), "kanji", kanji.common ? 1 : 0, JSON.stringify(kanji.tags));
        insertLookup.run(kanji.text, entryId, "kanji");
      }
      for (const kana of word.kana) {
        insertForm.run(entryId, kana.text, null, "kana", kana.common ? 1 : 0, JSON.stringify(kana.tags));
        insertLookup.run(kana.text, entryId, "reading");
      }

      const examplesBySensePosition = matchExampleSenses(word, examplesBySourceId.get(word.id), exampleStats);
      // Positions restart at 1 inside each explanation language while keeping
      // JMdict's editorial order, so one entry can have different meaning
      // counts and order per language.
      const nextPosition = new Map<ApiLang, number>();

      word.sense.forEach((sense, index) => {
        const baseSenseId = `yori:s_jmdict_${word.id}_${index + 1}`;
        const byLang = new Map<ApiLang, string>();
        const glossesByLang = new Map<ApiLang, typeof sense.gloss>();
        for (const gloss of sense.gloss) {
          const lang = toApiLang(gloss.lang);
          if (!lang) continue;
          glossesByLang.set(lang, [...(glossesByLang.get(lang) ?? []), gloss]);
        }

        for (const [lang, glosses] of glossesByLang) {
          const position = (nextPosition.get(lang) ?? 0) + 1;
          nextPosition.set(lang, position);
          const senseId = `${baseSenseId}:${lang}`;
          byLang.set(lang, senseId);
          insertSense.run(
            senseId,
            entryId,
            lang,
            position,
            JSON.stringify(sense.appliesToKanji),
            JSON.stringify(sense.appliesToKana),
            JSON.stringify(sense.partOfSpeech),
            JSON.stringify(sense.misc ?? []),
            JSON.stringify(sense.field ?? []),
            JSON.stringify(sense.dialect ?? []),
            JSON.stringify(sense.info ?? []),
            JSON.stringify(sense.related ?? []),
            JSON.stringify(sense.antonym ?? []),
            JSON.stringify(sense.languageSource ?? []),
            "[]",
            "[]",
            "source",
            "jmdict",
            sourceVersion,
            `jmdict:${word.id}:${index + 1}`,
            null
          );
          glosses.forEach((gloss, glossIndex) => {
            insertGloss.run(senseId, glossIndex + 1, gloss.text, gloss.type ?? null);
          });
        }

        importedSenses.set(baseSenseId, { entryId, jmdictSense: sense, position: index + 1, byLang });

        // A sourced example is a bilingual pair. It stays with the meaning of
        // the language it is paired with and is never copied into a language
        // whose sentence it does not carry.
        const positionsByLang = new Map<ApiLang, number>();
        for (const example of examplesBySensePosition.get(index) ?? []) {
          const japanese = example.sentences.find((sentence) => sentence.lang === "jpn")?.text;
          if (!japanese) {
            exampleStats.invalid += 1;
            continue;
          }
          let attached = false;
          for (const sentence of example.sentences) {
            const lang = toApiLang(sentence.lang);
            const senseId = lang ? byLang.get(lang) : undefined;
            if (!lang || !senseId) continue;
            const position = (positionsByLang.get(lang) ?? 0) + 1;
            positionsByLang.set(lang, position);
            insertExample.run(
              senseId,
              position,
              japanese,
              JSON.stringify([{ lang, text: sentence.text }]),
              example.source.type === "tatoeba" ? "Tatoeba" : example.source.type,
              example.source.value
            );
            attached = true;
          }
          if (attached) exampleStats.imported += 1;
          else exampleStats.unmatched += 1;
        }
      });
    }
  })(source.words);

  return { exampleStats, importedSenses };
}

function insertSenseStatement(db: Database) {
  return db.prepare(`
    insert into ja_senses (
      id, entry_id, lang, position, applies_to_kanji, applies_to_kana, part_of_speech,
      misc, field, dialect, info, related, antonym, language_source,
      pronunciations, pragmatic_functions, provenance, source_name, source_version, source_ref, generation_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

/**
 * Legacy accepted gloss records name an exact imported sense identifier, which
 * is the only route by which secondary content becomes canonical. Each record
 * creates a meaning inside its own explanation language rather than adding a
 * gloss to another language's meaning.
 */
function importLegacyGlosses(
  db: Database,
  rows: LegacyGlossRow[],
  importedSenses: Map<string, ImportedSense>,
  sourceVersion: string
) {
  const stats = { imported: 0, droppedUnknownSense: 0 };
  if (rows.length === 0) return stats;

  const insertSense = insertSenseStatement(db);
  const insertGloss = db.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status, type) values (?, ?, ?, 'generated', 'checked', null)"
  );
  const insertGeneration = db.prepare(`
    insert or ignore into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values (?, ?, 'unrecorded', 'unrecorded', 'legacy', null, 'accepted', 'legacy')
  `);
  const nextPosition = new Map<string, number>();
  const seen = new Set<string>();

  db.transaction((items: LegacyGlossRow[]) => {
    for (const row of items) {
      const lang = parseApiLang(row.lang);
      if (!lang) throw new Error(`Unsupported legacy gloss lang: ${row.lang}`);
      if (!Array.isArray(row.glosses) || row.glosses.length === 0) {
        throw new Error(`Legacy gloss row has no glosses: ${row.senseId}`);
      }
      const key = `${row.senseId}:${lang}`;
      if (seen.has(key)) throw new Error(`Duplicate legacy gloss row for ${key}`);
      seen.add(key);

      const imported = importedSenses.get(row.senseId);
      // The pinned source version may no longer contain the mapped meaning.
      // A deliberate rebuild drops it rather than failing the whole import.
      if (!imported) {
        stats.droppedUnknownSense += 1;
        continue;
      }
      if (imported.byLang.has(lang)) {
        throw new Error(`Legacy gloss row conflicts with imported ${lang} content: ${row.senseId}`);
      }

      const generationId = `legacy:${row.model ?? "unrecorded"}`;
      insertGeneration.run(generationId, row.model ?? "unrecorded");
      const counterKey = `${imported.entryId}:${lang}`;
      const position = (nextPosition.get(counterKey) ?? countSenses(db, imported.entryId, lang)) + 1;
      nextPosition.set(counterKey, position);
      const senseId = `${row.senseId}:${lang}`;
      const sense = imported.jmdictSense;
      insertSense.run(
        senseId,
        imported.entryId,
        lang,
        position,
        JSON.stringify(sense.appliesToKanji),
        JSON.stringify(sense.appliesToKana),
        JSON.stringify(sense.partOfSpeech),
        JSON.stringify(sense.misc ?? []),
        JSON.stringify(sense.field ?? []),
        JSON.stringify(sense.dialect ?? []),
        JSON.stringify(sense.info ?? []),
        JSON.stringify(sense.related ?? []),
        JSON.stringify(sense.antonym ?? []),
        JSON.stringify(sense.languageSource ?? []),
        "[]",
        "[]",
        "generated",
        row.source ?? "yori-legacy",
        sourceVersion,
        row.senseId,
        generationId
      );
      imported.byLang.set(lang, senseId);
      let glossPosition = 0;
      for (const gloss of row.glosses) {
        const text = gloss.trim();
        if (!text) continue;
        glossPosition += 1;
        insertGloss.run(senseId, glossPosition, text);
      }
      stats.imported += 1;
    }
  })(rows);

  return stats;
}

function countSenses(db: Database, entryId: string, lang: string): number {
  return db.query<{ count: number }, [string, string]>(
    "select count(*) as count from ja_senses where entry_id = ? and lang = ?"
  ).get(entryId, lang)?.count ?? 0;
}

/**
 * Accepted generated examples are attached only to the meaning of the language
 * whose sentence they carry, so a paired sentence never appears under another
 * language's meaning.
 */
function importLegacyExamples(
  db: Database,
  rows: LegacyExampleRow[],
  importedSenses: Map<string, ImportedSense>
) {
  const stats = { imported: 0, droppedUnknownSense: 0 };
  if (rows.length === 0) return stats;

  const insert = db.prepare(`
    insert or ignore into ja_examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status)
    values (?, 1, ?, ?, 'generated', null, null, 'checked')
  `);
  const seen = new Set<string>();

  db.transaction((items: LegacyExampleRow[]) => {
    for (const row of items) {
      if (seen.has(row.senseId)) throw new Error(`Duplicate legacy example row for ${row.senseId}`);
      seen.add(row.senseId);
      if (
        !row.example
        || row.example.source !== "generated"
        || row.example.reviewStatus !== "checked"
        || !row.example.text?.trim()
        || !Array.isArray(row.example.translations)
        || !Array.isArray(row.attempts)
        || row.attempts.length === 0
      ) throw new Error(`Invalid legacy example row for ${row.senseId}`);

      const imported = importedSenses.get(row.senseId);
      if (!imported) {
        stats.droppedUnknownSense += 1;
        continue;
      }
      let attached = false;
      for (const translation of row.example.translations) {
        const lang = parseApiLang(translation.lang);
        const senseId = lang ? imported.byLang.get(lang) : undefined;
        if (!lang || !senseId) continue;
        insert.run(
          senseId,
          row.example.text.trim(),
          JSON.stringify([{ lang, text: translation.text }])
        );
        attached = true;
      }
      if (attached) stats.imported += 1;
      else stats.droppedUnknownSense += 1;
    }
  })(rows);

  return stats;
}

function emptyRetained(): Retained {
  return { entries: [], groups: [], examples: [], exampleGenerations: [] };
}

/**
 * Accepted enrichment survives a rebuild with its own provenance: generated
 * entries are carried whole, accepted language groups authored for an imported
 * entry are carried per language, and generated examples on imported meanings
 * are re-attached by their language-scoped meaning identifier.
 */
function readRetained(path: string): Retained {
  const db = new Database(path, { readonly: true });
  try {
    if (!hasJapaneseSchema(db)) return emptyRetained();
    const generatedIds = db.query<{ id: string }, []>(
      "select id from ja_entries where source = 'generated' order by id"
    ).all().map((row) => row.id);

    const entries = generatedIds.map<RetainedEntry>((entryId) => {
      const entry = db.query<RetainedEntry["entry"], [string]>(`
        select id, source, source_id as sourceId, headword_language as headwordLanguage,
               estimated_level as estimatedLevel
          from ja_entries where id = ?
      `).get(entryId)!;
      const senses = db.query<Record<string, unknown>, [string]>(
        "select * from ja_senses where entry_id = ? order by lang, position"
      ).all(entryId);
      const senseIds = senses.map((sense) => String(sense.id));
      return {
        entry,
        forms: db.query<Record<string, unknown>, [string]>("select * from ja_forms where entry_id = ?").all(entryId),
        lookupTerms: db.query<Record<string, unknown>, [string]>(
          "select * from ja_lookup_terms where entry_id = ?"
        ).all(entryId),
        senses,
        glosses: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from ja_glosses where sense_id = ? order by position"
        ).all(senseId)),
        examples: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from ja_examples where sense_id = ? order by position"
        ).all(senseId)),
        generations: db.query<Record<string, unknown>, [string, string]>(`
          select * from ja_generations where id in (
            select generation_id from ja_senses where entry_id = ? and generation_id is not null
            union
            select example.generation_id from ja_examples example
              join ja_senses sense on sense.id = example.sense_id
             where sense.entry_id = ? and example.generation_id is not null
          )
        `).all(entryId, entryId)
      };
    });

    // What enrichment usually produces is a language group under an imported
    // entry. It is retained per entry and language, because the entry itself
    // comes back from the sources.
    const groups = db.query<{ entry_id: string; lang: string }, []>(`
      select sense.entry_id as entry_id, sense.lang as lang
        from ja_senses sense
        join ja_entries entry on entry.id = sense.entry_id
       where sense.generation_id is not null and entry.source <> 'generated'
       group by sense.entry_id, sense.lang
       order by sense.entry_id, sense.lang
    `).all().map<RetainedGroup>(({ entry_id: entryId, lang }) => {
      const senses = db.query<Record<string, unknown>, [string, string]>(
        "select * from ja_senses where entry_id = ? and lang = ? order by position"
      ).all(entryId, lang);
      const senseIds = senses.map((sense) => String(sense.id));
      return {
        entryId,
        lang,
        senses,
        glosses: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from ja_glosses where sense_id = ? order by position"
        ).all(senseId)),
        examples: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from ja_examples where sense_id = ? order by position"
        ).all(senseId)),
        generations: db.query<Record<string, unknown>, [string, string, string, string]>(`
          select * from ja_generations where id in (
            select generation_id from ja_senses
             where entry_id = ? and lang = ? and generation_id is not null
            union
            select example.generation_id from ja_examples example
              join ja_senses sense on sense.id = example.sense_id
             where sense.entry_id = ? and sense.lang = ? and example.generation_id is not null
          )
        `).all(entryId, lang, entryId, lang)
      };
    });

    const retainedSenseIds = new Set(groups.flatMap((group) => group.senses.map((sense) => String(sense.id))));
    const examples = db.query<Record<string, unknown>, []>(`
      select example.* from ja_examples example
        join ja_senses sense on sense.id = example.sense_id
        join ja_entries entry on entry.id = sense.entry_id
       where example.source = 'generated' and entry.source <> 'generated'
       order by example.sense_id, example.position
    `).all().filter((example) => !retainedSenseIds.has(String(example.sense_id)));

    // A generated example on an imported meaning carries its own generation
    // reference, so the row it points at is retained with it.
    const exampleGenerationIds = [...new Set(
      examples.map((example) => example.generation_id).filter((id): id is string => typeof id === "string")
    )];
    const exampleGenerations = exampleGenerationIds.length === 0 ? [] : db.query<Record<string, unknown>, string[]>(
      `select * from ja_generations where id in (${exampleGenerationIds.map(() => "?").join(", ")})`
    ).all(...exampleGenerationIds);

    return { entries, groups, examples, exampleGenerations };
  } finally {
    db.close();
  }
}

function restoreRetained(
  db: Database,
  retained: Retained
): { entries: number; groups: number; examples: number } {
  let entries = 0;
  let groups = 0;
  let examples = 0;
  db.transaction(() => {
    for (const record of retained.entries) {
      // An authored Japanese entry and an imported one never share an id, so
      // the written forms decide whether the sources now carry this word.
      const terms = record.lookupTerms.map((term) => String(term.term));
      const existing = db.query<{ id: string }, [string]>("select id from ja_entries where id = ?")
        .get(record.entry.id)
        ?? (terms.length === 0 ? null : db.query<{ id: string }, string[]>(`
          select distinct entry_id as id from ja_lookup_terms
           where term in (${terms.map(() => "?").join(", ")})
        `).get(...terms));
      if (existing) {
        // The sources now provide this headword, so the imported entry is the
        // canonical one. The accepted language groups the entry was enriched
        // with move onto it rather than being restored as a second entry the
        // same query would also match.
        groups += reattachGroups(db, record, existing.id);
        continue;
      }
      db.prepare(`
        insert into ja_entries (id, source, source_id, headword_language, estimated_level)
        values (?, ?, ?, ?, ?)
      `).run(
        record.entry.id,
        record.entry.source,
        record.entry.sourceId,
        record.entry.headwordLanguage,
        record.entry.estimatedLevel
      );
      for (const generation of record.generations) insertRow(db, "ja_generations", generation, true);
      for (const form of record.forms) insertRow(db, "ja_forms", form, true);
      for (const term of record.lookupTerms) insertRow(db, "ja_lookup_terms", term, true);
      for (const sense of record.senses) insertRow(db, "ja_senses", sense, false);
      for (const gloss of record.glosses) insertRow(db, "ja_glosses", gloss, false);
      for (const example of record.examples) insertRow(db, "ja_examples", example, false);
      entries += 1;
    }
    for (const group of retained.groups) {
      // The entry must still exist in the rebuilt sources, and the rebuild must
      // not already explain it in this language: imported content wins, and a
      // retained group never reorders it.
      if (!db.query<{ id: string }, [string]>("select id from ja_entries where id = ?").get(group.entryId)) continue;
      if (db.query<{ id: string }, [string, string]>(
        "select id from ja_senses where entry_id = ? and lang = ? limit 1"
      ).get(group.entryId, group.lang)) continue;
      for (const generation of group.generations) insertRow(db, "ja_generations", generation, true);
      for (const sense of group.senses) insertRow(db, "ja_senses", sense, false);
      for (const gloss of group.glosses) insertRow(db, "ja_glosses", gloss, false);
      for (const example of group.examples) insertRow(db, "ja_examples", example, false);
      groups += 1;
    }
    for (const generation of retained.exampleGenerations) {
      insertRow(db, "ja_generations", generation, true);
    }
    for (const example of retained.examples) {
      const senseId = String(example.sense_id);
      if (!db.query<{ id: string }, [string]>("select id from ja_senses where id = ?").get(senseId)) continue;
      // The rebuilt meaning may have gained or lost imported examples, so the
      // retained one is appended rather than dropped onto a taken position.
      const next = db.query<{ position: number }, [string]>(
        "select coalesce(max(position), 0) + 1 as position from ja_examples where sense_id = ?"
      ).get(senseId)!.position;
      insertRow(db, "ja_examples", { ...example, position: next }, true);
      examples += 1;
    }
  })();
  return { entries, groups, examples };
}


/**
 * Moves a retained entry's accepted language groups onto an entry the rebuilt
 * sources now provide. A language the sources already explain is left alone:
 * imported content wins, and a retained group never reorders it.
 */
function reattachGroups(db: Database, record: RetainedEntry, entryId: string): number {
  const byLang = new Map<string, Array<Record<string, unknown>>>();
  for (const sense of record.senses) {
    const lang = String(sense.lang);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push(sense);
  }

  let moved = 0;
  for (const [lang, senses] of byLang) {
    // Only accepted enrichment travels; it is marked by its generation row.
    if (!senses.some((sense) => sense.generation_id !== null && sense.generation_id !== undefined)) continue;
    if (db.query<{ id: string }, [string, string]>(
      "select id from ja_senses where entry_id = ? and lang = ? limit 1"
    ).get(entryId, lang)) continue;

    const senseIds = new Set(senses.map((sense) => String(sense.id)));
    for (const generation of record.generations) insertRow(db, "ja_generations", generation, true);
    for (const sense of senses) insertRow(db, "ja_senses", { ...sense, entry_id: entryId }, false);
    for (const gloss of record.glosses) {
      if (senseIds.has(String(gloss.sense_id))) insertRow(db, "ja_glosses", gloss, false);
    }
    for (const example of record.examples) {
      if (senseIds.has(String(example.sense_id))) insertRow(db, "ja_examples", example, false);
    }
    moved += 1;
  }
  return moved;
}

function matchExampleSenses(
  word: JmdictWord,
  exampleWord: JmdictWord | undefined,
  stats: { unmatched: number; ambiguous: number }
): Map<number, NonNullable<JmdictWord["sense"][number]["examples"]>> {
  const matched = new Map<number, NonNullable<JmdictWord["sense"][number]["examples"]>>();
  if (!exampleWord) return matched;

  const targetKeys = word.sense.map(senseIdentity);
  const sourceGroups = new Map<string, Array<NonNullable<JmdictWord["sense"][number]["examples"]>>>();
  for (const exampleSense of exampleWord.sense) {
    const examples = exampleSense.examples ?? [];
    if (examples.length === 0) continue;
    const key = senseIdentity(exampleSense);
    sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), examples]);
  }

  for (const [key, sourceSenses] of sourceGroups) {
    const examples = sourceSenses.flat();
    const candidates = targetKeys
      .map((targetKey, index) => (targetKey === key ? index : -1))
      .filter((index) => index !== -1);
    if (candidates.length === 1 && sourceSenses.length === 1) matched.set(candidates[0], examples);
    else if (candidates.length === 0) stats.unmatched += examples.length;
    else stats.ambiguous += examples.length;
  }
  return matched;
}

function countExamples(word: JmdictWord): number {
  return word.sense.reduce((count, sense) => count + (sense.examples?.length ?? 0), 0);
}

function senseIdentity(sense: JmdictWord["sense"][number]): string {
  return JSON.stringify({
    partOfSpeech: sense.partOfSpeech,
    appliesToKanji: sense.appliesToKanji,
    appliesToKana: sense.appliesToKana,
    related: sense.related ?? [],
    antonym: sense.antonym ?? [],
    field: sense.field ?? [],
    dialect: sense.dialect ?? [],
    misc: sense.misc ?? [],
    info: sense.info ?? [],
    languageSource: sense.languageSource ?? [],
    gloss: sense.gloss.map((gloss) => ({
      lang: gloss.lang,
      gender: gloss.gender ?? null,
      type: gloss.type ?? null,
      text: gloss.text
    }))
  });
}

function readingForKanji(word: JmdictWord, kanjiText: string): string | null {
  const matchingKana = word.kana.find(
    (kana) => kana.appliesToKanji.includes("*") || kana.appliesToKanji.includes(kanjiText)
  );
  return matchingKana?.text ?? word.kana[0]?.text ?? null;
}

async function readEstimatedLevels(directory: string): Promise<Map<string, EstimatedLevel>> {
  const levels = new Map<string, EstimatedLevel>();
  const files = (await readdir(directory)).filter((file) => /^n[1-5]\.csv$/i.test(file)).sort();
  if (files.length !== 5) throw new Error(`Expected n1.csv through n5.csv in ${directory}`);
  for (const file of files) {
    const match = basename(file).match(/^n([1-5])\.csv$/i);
    if (!match) continue;
    const level = `N${match[1]}` as EstimatedLevel;
    const lines = (await Bun.file(join(directory, file)).text()).split(/\r?\n/).slice(1);
    for (const line of lines) {
      const separator = line.indexOf(",");
      if (separator === -1) continue;
      const sourceId = line.slice(0, separator).trim();
      if (!/^\d+$/.test(sourceId)) continue;
      const current = levels.get(sourceId);
      if (!current || Number(level.slice(1)) > Number(current.slice(1))) levels.set(sourceId, level);
    }
  }
  return levels;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

