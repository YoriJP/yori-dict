import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeImportedGerman } from "../src/production-database";
import { createJapaneseSchema } from "../src/japanese-schema";

/**
 * A volume bootstrapped from a release built before the `ger` mapping was
 * dropped: imported German alongside imported English, plus an authored German
 * group of the kind Enrich-on-Lookup writes.
 */
function store(): string {
  const path = join(mkdtempSync(join(tmpdir(), "yori-german-")), "yori.sqlite");
  const db = new Database(path, { create: true });
  createJapaneseSchema(db);
  db.exec(`
    insert into ja_metadata (key, value) values ('dictDate', '2026-06-01');
    insert into ja_entries (id, source, source_id, headword_language)
      values ('e1', 'jmdict', '1358280', 'ja');
    insert into ja_forms (entry_id, text, reading, kind, common, tags)
      values ('e1', '食べる', 'たべる', 'kanji', 1, '[]');

    insert into ja_senses (id, entry_id, lang, position, part_of_speech, provenance,
      applies_to_kanji, applies_to_kana, misc, field, dialect, info, related, antonym, language_source)
      values ('s_en', 'e1', 'en', 1, '["v1"]', 'source', '["*"]', '["*"]', '[]', '[]', '[]', '[]', '[]', '[]', '[]');
    insert into ja_glosses (sense_id, position, text, source, review_status)
      values ('s_en', 1, 'to eat', 'jmdict', 'source');

    insert into ja_senses (id, entry_id, lang, position, part_of_speech, provenance,
      applies_to_kanji, applies_to_kana, misc, field, dialect, info, related, antonym, language_source)
      values ('s_de', 'e1', 'de', 1, '["v1"]', 'source', '["*"]', '["*"]', '[]', '[]', '[]', '[]', '[]', '[]', '[]');
    insert into ja_glosses (sense_id, position, text, source, review_status)
      values ('s_de', 1, 'essen', 'jmdict', 'source');
    insert into ja_examples (sense_id, position, text, translations, source, review_status)
      values ('s_de', 1, '私は食べる。', '[{"lang":"de","text":"Ich esse."}]', 'sourced', 'source');

    insert into ja_senses (id, entry_id, lang, position, part_of_speech, provenance,
      applies_to_kanji, applies_to_kana, misc, field, dialect, info, related, antonym, language_source)
      values ('s_de_gen', 'e1', 'de', 2, '["v1"]', 'generated', '["*"]', '["*"]', '[]', '[]', '[]', '[]', '[]', '[]', '[]');
    insert into ja_glosses (sense_id, position, text, source, review_status)
      values ('s_de_gen', 1, 'speisen', 'generated', 'checked');
  `);
  // `exec` does not surface a constraint failure in a later statement, so a
  // schema change could otherwise leave this fixture empty and the assertions
  // below vacuously true.
  const seededSenses = db.query<{ count: number }, []>("select count(*) as count from ja_senses").get()?.count;
  const seededExamples = db.query<{ count: number }, []>("select count(*) as count from ja_examples").get()?.count;
  if (seededSenses !== 3 || seededExamples !== 1) {
    throw new Error(`Fixture seeded ${seededSenses} senses and ${seededExamples} examples, expected 3 and 1`);
  }
  db.close();
  return path;
}

function langs(path: string): Array<{ id: string; lang: string; provenance: string }> {
  const db = new Database(path, { readonly: true });
  const rows = db.query<{ id: string; lang: string; provenance: string }, []>(
    "select id, lang, provenance from ja_senses order by id"
  ).all();
  db.close();
  return rows;
}

test("imported German is removed, because Yori Dict has no grant to serve it", () => {
  const path = store();
  expect(removeImportedGerman(path)).toBe(1);

  // The imported German sense is gone, and so is everything hanging off it.
  const db = new Database(path, { readonly: true });
  expect(db.query<{ count: number }, []>(
    "select count(*) as count from ja_glosses where sense_id = 's_de'"
  ).get()?.count).toBe(0);
  expect(db.query<{ count: number }, []>(
    "select count(*) as count from ja_examples where sense_id = 's_de'"
  ).get()?.count).toBe(0);
  db.close();

  // English is untouched, and authored German survives: the problem was an
  // unlicensed source, not the language, and that group is Yori's own content.
  expect(langs(path)).toEqual([
    { id: "s_de_gen", lang: "de", provenance: "generated" },
    { id: "s_en", lang: "en", provenance: "source" }
  ]);
});

test("removal is idempotent and safe on a store with no Japanese dictionary", () => {
  const path = store();
  expect(removeImportedGerman(path)).toBe(1);
  // Every later start finds nothing to do rather than failing or rewriting.
  expect(removeImportedGerman(path)).toBe(0);

  const empty = join(mkdtempSync(join(tmpdir(), "yori-german-empty-")), "yori.sqlite");
  expect(removeImportedGerman(empty)).toBe(0);
});
