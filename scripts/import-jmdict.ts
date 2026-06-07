import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import type { JmdictFile, JmdictWord } from "../src/types";
import { toApiLang } from "../src/lang";

type Args = {
  input: string;
  out: string;
};

const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${dirname(args.out)}`;
await Bun.$`rm -f ${args.out}`;
await Bun.$`rm -f ${args.out}-shm`;
await Bun.$`rm -f ${args.out}-wal`;

const source = (await Bun.file(args.input).json()) as JmdictFile;
const db = new Database(args.out);

createSchema(db);
insertMetadata(db, source);
insertWords(db, source.words);
db.close();

console.log(`Imported ${source.words.length} JMdict entries into ${args.out}`);

function parseArgs(argv: string[]): Args {
  const input = readFlag(argv, "--input");
  const out = readFlag(argv, "--out");
  if (!input || !out) {
    console.error("Usage: bun run scripts/import-jmdict.ts --input path/to/jmdict.json --out data/yori.sqlite");
    process.exit(1);
  }
  return { input, out };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function createSchema(db: Database) {
  db.exec(`
    pragma journal_mode = DELETE;
    pragma synchronous = OFF;

    create table metadata (
      key text primary key,
      value text not null
    );

    create table entries (
      id text primary key,
      source text not null,
      source_id text not null unique
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
      part_of_speech text not null
    );

    create table glosses (
      sense_id text not null references senses(id),
      lang text not null,
      text text not null
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
  `);
}

function insertMetadata(db: Database, source: JmdictFile) {
  const insert = db.prepare("insert into metadata (key, value) values (?, ?)");
  if (source.version) insert.run("jmdictSimplifiedVersion", source.version);
  if (source.dictDate) insert.run("dictDate", source.dictDate);
  if (source.languages) insert.run("sourceLanguages", JSON.stringify(source.languages));
}

function insertWords(db: Database, words: JmdictWord[]) {
  const insertEntry = db.prepare("insert into entries (id, source, source_id) values (?, 'jmdict', ?)");
  const insertForm = db.prepare(
    "insert into forms (entry_id, text, reading, kind, common, tags) values (?, ?, ?, ?, ?, ?)"
  );
  const insertSense = db.prepare(
    `insert into senses
      (id, entry_id, position, applies_to_kanji, applies_to_kana, part_of_speech)
     values (?, ?, ?, ?, ?, ?)`
  );
  const insertGloss = db.prepare("insert into glosses (sense_id, lang, text) values (?, ?, ?)");
  const insertLookup = db.prepare(
    "insert into lookup_terms (term, entry_id, match_kind) values (?, ?, ?)"
  );

  const transaction = db.transaction((items: JmdictWord[]) => {
    for (const word of items) {
      const entryId = yoriEntryId(word.id);
      insertEntry.run(entryId, word.id);

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
          JSON.stringify(sense.partOfSpeech)
        );

        for (const gloss of sense.gloss) {
          const apiLang = toApiLang(gloss.lang);
          if (!apiLang) continue;
          insertGloss.run(senseId, apiLang, gloss.text);
        }
      });
    }
  });

  transaction(words);
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
