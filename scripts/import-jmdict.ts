import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import type { EstimatedLevel, JmdictFile, JmdictWord } from "../src/types";
import { parseApiLang, toApiLang } from "../src/lang";

type Args = {
  input: string;
  out: string;
  aiGlosses: string[];
  aiExamples: string[];
  examples: string | null;
  jlptVocab: string | null;
};

type AiGlossSource = {
  senseId: string;
  lang: string;
  glosses: string[];
  source?: "ai-assisted";
  model?: string;
};

type AiExampleSource = {
  senseId: string;
  example: {
    text: string;
    translations: Array<{ lang: string; text: string }>;
    source: "generated";
    reviewStatus: "checked";
  };
  attempts: unknown[];
};

const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${dirname(args.out)}`;
await Bun.$`rm -f ${args.out}`;
await Bun.$`rm -f ${args.out}-shm`;
await Bun.$`rm -f ${args.out}-wal`;

const source = (await Bun.file(args.input).json()) as JmdictFile;
const exampleSource = args.examples ? ((await Bun.file(args.examples).json()) as JmdictFile) : null;
if (exampleSource && source.version !== exampleSource.version) {
  throw new Error(
    `JMdict example version ${exampleSource.version ?? "unknown"} does not match dictionary version ${source.version ?? "unknown"}`
  );
}
const estimatedLevels = args.jlptVocab
  ? await readEstimatedLevels(args.jlptVocab)
  : new Map<string, EstimatedLevel>();
const aiGlosses = (await Promise.all(args.aiGlosses.map((path) => readJsonl<AiGlossSource>(path)))).flat();
const aiExamples = (await Promise.all(args.aiExamples.map((path) => readJsonl<AiExampleSource>(path)))).flat();
const db = new Database(args.out);

createSchema(db);
insertMetadata(db, source);
const sourcedExampleStats = insertWords(db, source.words, exampleSource, estimatedLevels);
insertAiGlosses(db, aiGlosses);
insertAiExamples(db, aiExamples);
db.close();

console.log(`Imported ${source.words.length} JMdict entries into ${args.out}`);
if (exampleSource) {
  console.log(
    `Imported ${sourcedExampleStats.imported} sourced example(s); ` +
      `skipped ${sourcedExampleStats.unmatched} unmatched, ` +
      `${sourcedExampleStats.ambiguous} ambiguous, and ${sourcedExampleStats.invalid} invalid example(s)`
  );
}
if (aiGlosses.length > 0) {
  console.log(`Imported ${aiGlosses.length} AI gloss source row(s)`);
}
if (aiExamples.length > 0) console.log(`Imported ${aiExamples.length} AI example source row(s)`);

function parseArgs(argv: string[]): Args {
  const input = readFlag(argv, "--input");
  const out = readFlag(argv, "--out");
  if (!input || !out) {
    console.error(
      "Usage: bun run scripts/import-jmdict.ts --input path/to/jmdict.json --out data/yori.sqlite [--examples path/to/jmdict-examples.json] [--jlpt-vocab path/to/jlpt-csv-directory] [--ai-glosses path/to/glosses.jsonl]... [--ai-examples path/to/examples.jsonl]..."
    );
    process.exit(1);
  }
  return {
    input,
    out,
    examples: readFlag(argv, "--examples"),
    jlptVocab: readFlag(argv, "--jlpt-vocab"),
    aiGlosses: readFlags(argv, "--ai-glosses"),
    aiExamples: readFlags(argv, "--ai-examples")
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function readFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) {
      values.push(argv[index + 1]);
    }
  }
  return values;
}

function createSchema(db: Database) {
  db.exec(`
    pragma journal_mode = OFF;
    pragma synchronous = OFF;

    create table metadata (
      key text primary key,
      value text not null
    );

    create table entries (
      id text primary key,
      source text not null,
      source_id text not null unique,
      headword_language text not null,
      estimated_level text check (estimated_level in ('N1', 'N2', 'N3', 'N4', 'N5'))
    );

    create table forms (
      entry_id text not null references entries(id),
      text text not null,
      reading text,
      kind text not null check (kind in ('kanji', 'kana')),
      common integer not null check (common in (0, 1)),
      tags text not null
    );

    create table senses (
      id text primary key,
      entry_id text not null references entries(id),
      position integer not null,
      applies_to_kanji text not null,
      applies_to_kana text not null,
      part_of_speech text not null,
      misc text not null,
      field text not null,
      dialect text not null,
      info text not null,
      related text not null,
      antonym text not null,
      language_source text not null
    );

    create table glosses (
      sense_id text not null references senses(id),
      lang text not null,
      text text not null,
      source text not null check (source in ('jmdict', 'ai-assisted')),
      review_status text not null check (review_status in ('source', 'checked')),
      type text
    );

    create table examples (
      sense_id text not null references senses(id),
      position integer not null,
      text text not null,
      translations text not null,
      source text not null check (source in ('sourced', 'generated')),
      source_name text,
      source_id text,
      review_status text not null check (review_status in ('source', 'checked')),
      check (
        (source = 'sourced' and review_status = 'source') or
        (source = 'generated' and review_status = 'checked')
      ),
      unique (sense_id, position)
    );

    create table lookup_terms (
      term text not null,
      entry_id text not null references entries(id),
      match_kind text not null check (match_kind in ('kanji', 'reading'))
    );

    create index lookup_terms_term_idx on lookup_terms(term);
    create index forms_entry_idx on forms(entry_id);
    create index senses_entry_idx on senses(entry_id);
    create index glosses_sense_idx on glosses(sense_id);
    create index examples_sense_idx on examples(sense_id);
  `);
}

function insertMetadata(db: Database, source: JmdictFile) {
  const insert = db.prepare("insert into metadata (key, value) values (?, ?)");
  if (source.version) insert.run("jmdictSimplifiedVersion", source.version);
  if (source.dictDate) insert.run("dictDate", source.dictDate);
  if (source.languages) insert.run("sourceLanguages", JSON.stringify(source.languages));
  if (source.tags) insert.run("tags", JSON.stringify(source.tags));
}

function insertWords(
  db: Database,
  words: JmdictWord[],
  exampleSource: JmdictFile | null,
  estimatedLevels: Map<string, EstimatedLevel>
) {
  const exampleStats = { imported: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
  const insertEntry = db.prepare(
    "insert into entries (id, source, source_id, headword_language, estimated_level) values (?, 'jmdict', ?, 'ja', ?)"
  );
  const insertForm = db.prepare(
    "insert into forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)"
  );
  const insertSense = db.prepare(
    `insert into senses
      (id, entry_id, position, applies_to_kanji, applies_to_kana, part_of_speech,
       misc, field, dialect, info, related, antonym, language_source)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertGloss = db.prepare(
    `insert into glosses (sense_id, lang, text, source, review_status, type)
     values (?, ?, ?, 'jmdict', 'source', ?)`
  );
  const insertLookup = db.prepare(
    "insert into lookup_terms (term, entry_id, match_kind) values (?, ?, ?)"
  );
  const insertExample = db.prepare(
    `insert into examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status)
     values (?, ?, ?, ?, 'sourced', ?, ?, 'source')`
  );
  const examplesBySourceId = new Map((exampleSource?.words ?? []).map((word) => [word.id, word]));
  const wordSourceIds = new Set(words.map((word) => word.id));
  for (const exampleWord of exampleSource?.words ?? []) {
    if (!wordSourceIds.has(exampleWord.id)) {
      exampleStats.unmatched += countExamples(exampleWord);
    }
  }
  const transaction = db.transaction((items: JmdictWord[]) => {
    for (const word of items) {
      const entryId = yoriEntryId(word.id);
      insertEntry.run(entryId, word.id, estimatedLevels.get(word.id) ?? null);
      const exampleWord = examplesBySourceId.get(word.id);
      const examplesBySensePosition = matchExampleSenses(word, exampleWord, exampleStats);

      const lookupTerms = new Set<string>();
      for (const kanji of word.kanji) {
        const reading = readingForKanji(word, kanji.text);
        insertForm.run(entryId, kanji.text, reading, "kanji", kanji.common ? 1 : 0, JSON.stringify(kanji.tags));
        lookupTerms.add(`kanji:${kanji.text}`);
      }

      for (const kana of word.kana) {
        insertForm.run(entryId, kana.text, null, "kana", kana.common ? 1 : 0, JSON.stringify(kana.tags));
        lookupTerms.add(`reading:${kana.text}`);
      }

      for (const term of lookupTerms) {
        const [matchKind, text] = term.split(":");
        insertLookup.run(text, entryId, matchKind);
      }

      word.sense.forEach((sense, index) => {
        const senseId = yoriSenseId(word.id, index + 1);
        insertSense.run(
          senseId,
          entryId,
          index + 1,
          JSON.stringify(sense.appliesToKanji),
          JSON.stringify(sense.appliesToKana),
          JSON.stringify(sense.partOfSpeech),
          JSON.stringify(sense.misc ?? []),
          JSON.stringify(sense.field ?? []),
          JSON.stringify(sense.dialect ?? []),
          JSON.stringify(sense.info ?? []),
          JSON.stringify(sense.related ?? []),
          JSON.stringify(sense.antonym ?? []),
          JSON.stringify(sense.languageSource ?? [])
        );

        for (const gloss of sense.gloss) {
          const apiLang = toApiLang(gloss.lang);
          if (!apiLang) continue;
          insertGloss.run(senseId, apiLang, gloss.text, gloss.type ?? null);
        }

        for (const [exampleIndex, example] of (examplesBySensePosition.get(index)?.entries() ?? [])) {
          const japanese = example.sentences.find((sentence) => sentence.lang === "jpn")?.text;
          if (!japanese) {
            exampleStats.invalid += 1;
            continue;
          }
          const translations = example.sentences
            .filter((sentence) => sentence.lang !== "jpn")
            .map((sentence) => ({ lang: toApiLang(sentence.lang) ?? sentence.lang, text: sentence.text }));
          insertExample.run(
            senseId,
            exampleIndex + 1,
            japanese,
            JSON.stringify(translations),
            example.source.type === "tatoeba" ? "Tatoeba" : example.source.type,
            example.source.value
          );
          exampleStats.imported += 1;
        }
      });
    }
  });

  transaction(words);
  return exampleStats;
}

function matchExampleSenses(
  word: JmdictWord,
  exampleWord: JmdictWord | undefined,
  stats: { unmatched: number; ambiguous: number }
): Map<number, NonNullable<JmdictWord["sense"][number]["examples"]>> {
  const matched = new Map<number, NonNullable<JmdictWord["sense"][number]["examples"]>>();
  if (!exampleWord) return matched;

  const targetKeys = word.sense.map(senseIdentity);
  const sourceGroups = new Map<
    string,
    Array<NonNullable<JmdictWord["sense"][number]["examples"]>>
  >();
  for (const exampleSense of exampleWord.sense) {
    const examples = exampleSense.examples ?? [];
    if (examples.length === 0) continue;
    const key = senseIdentity(exampleSense);
    const group = sourceGroups.get(key) ?? [];
    group.push(examples);
    sourceGroups.set(key, group);
  }

  for (const [key, sourceSenses] of sourceGroups) {
    const examples = sourceSenses.flat();
    const candidates = targetKeys
      .map((targetKey, index) => (targetKey === key ? index : -1))
      .filter((index) => index !== -1);
    if (candidates.length === 1 && sourceSenses.length === 1) {
      matched.set(candidates[0], examples);
    } else if (candidates.length === 0) {
      stats.unmatched += examples.length;
    } else {
      stats.ambiguous += examples.length;
    }
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

async function readEstimatedLevels(directory: string): Promise<Map<string, EstimatedLevel>> {
  const levels = new Map<string, EstimatedLevel>();
  const files = (await readdir(directory)).filter((file) => /^n[1-5]\.csv$/i.test(file)).sort();
  if (files.length !== 5) {
    throw new Error(`Expected n1.csv through n5.csv in ${directory}`);
  }
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
      if (!current || Number(level.slice(1)) > Number(current.slice(1))) {
        levels.set(sourceId, level);
      }
    }
  }
  return levels;
}

function insertAiGlosses(db: Database, rows: AiGlossSource[]) {
  if (rows.length === 0) return;

  const senseExists = db.prepare("select 1 from senses where id = ? limit 1");
  const existingGlosses = db.prepare("select count(*) as count from glosses where sense_id = ? and lang = ?");
  const insertGloss = db.prepare(
    "insert into glosses (sense_id, lang, text, source, review_status) values (?, ?, ?, 'ai-assisted', 'checked')"
  );

  const seen = new Set<string>();
  const transaction = db.transaction((items: AiGlossSource[]) => {
    for (const row of items) {
      const apiLang = parseApiLang(row.lang);
      if (!apiLang) {
        throw new Error(`Unsupported AI gloss lang: ${row.lang}`);
      }
      if (!Array.isArray(row.glosses) || row.glosses.length === 0) {
        throw new Error(`AI gloss row has no glosses: ${row.senseId}`);
      }
      if (!senseExists.get(row.senseId)) {
        throw new Error(`AI gloss references unknown senseId: ${row.senseId}`);
      }

      const key = `${row.senseId}:${apiLang}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate AI gloss row for ${key}`);
      }
      seen.add(key);

      const existing = existingGlosses.get(row.senseId, apiLang) as { count: number } | null;
      if ((existing?.count ?? 0) > 0) {
        throw new Error(`AI gloss row conflicts with existing ${apiLang} glosses: ${row.senseId}`);
      }

      for (const gloss of row.glosses) {
        const text = gloss.trim();
        if (text.length === 0) continue;
        insertGloss.run(row.senseId, apiLang, text);
      }
    }
  });

  transaction(rows);
}

function insertAiExamples(db: Database, rows: AiExampleSource[]) {
  if (rows.length === 0) return;
  const senseExists = db.prepare("select 1 from senses where id = ? limit 1");
  const exampleCount = db.prepare("select count(*) as count from examples where sense_id = ?");
  const insert = db.prepare(
    `insert into examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status)
     values (?, 1, ?, ?, 'generated', null, null, 'checked')`
  );
  const seen = new Set<string>();
  const transaction = db.transaction((items: AiExampleSource[]) => {
    for (const row of items) {
      if (seen.has(row.senseId)) throw new Error(`Duplicate AI example row for ${row.senseId}`);
      seen.add(row.senseId);
      if (!senseExists.get(row.senseId)) throw new Error(`AI example references unknown senseId: ${row.senseId}`);
      const existing = exampleCount.get(row.senseId) as { count: number } | null;
      if ((existing?.count ?? 0) > 0) continue;
      if (
        !row.example ||
        row.example.source !== "generated" ||
        row.example.reviewStatus !== "checked" ||
        !row.example.text?.trim() ||
        !Array.isArray(row.example.translations) ||
        !Array.isArray(row.attempts) ||
        row.attempts.length === 0
      ) {
        throw new Error(`Invalid AI example row for ${row.senseId}`);
      }
      insert.run(row.senseId, row.example.text.trim(), JSON.stringify(row.example.translations));
    }
  });
  transaction(rows);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function readingForKanji(word: JmdictWord, kanjiText: string): string | null {
  const matchingKana = word.kana.find(
    (kana) => kana.appliesToKanji.includes("*") || kana.appliesToKanji.includes(kanjiText)
  );
  return matchingKana?.text ?? word.kana[0]?.text ?? null;
}

function yoriEntryId(sourceId: string): string {
  return `yori:e_jmdict_${sourceId}`;
}

function yoriSenseId(sourceId: string, position: number): string {
  return `yori:s_jmdict_${sourceId}_${position}`;
}
