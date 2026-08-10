import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureJapaneseProductionDatabase,
  migrateProductionDatabase,
  removeImportedGerman
} from "../src/production-database";
import { createJapaneseSchema } from "../src/japanese-schema";

/**
 * A volume as a backfill leaves it: an imported entry, plus the accepted
 * zh-TW group and example that Enrich-on-Lookup paid a model to author.
 */
function enrichedStore(): string {
  const path = join(mkdtempSync(join(tmpdir(), "yori-deploy-")), "yori.sqlite");
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

    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, review_outcome, created_at)
      values ('gen1', 'test', 'test', 'minimal', 'entry-author-v1', 'accepted', '2026-08-10');
    insert into ja_senses (id, entry_id, lang, position, part_of_speech, provenance,
      applies_to_kanji, applies_to_kana, misc, field, dialect, info, related, antonym, language_source,
      generation_id)
      values ('s_zh', 'e1', 'zh-tw', 1, '["v1"]', 'generated', '["*"]', '["*"]', '[]', '[]', '[]', '[]', '[]', '[]', '[]',
        'gen1');
    insert into ja_glosses (sense_id, position, text, source, review_status)
      values ('s_zh', 1, '吃', 'generated', 'checked');
    insert into ja_examples (sense_id, position, text, translations, source, review_status, generation_id)
      values ('s_zh', 1, '私はご飯を食べる。', '[{"lang":"zh-tw","text":"我吃飯。"}]', 'generated', 'checked', 'gen1');
  `);
  const written = db.query<{ count: number }, []>(
    "select count(*) as count from ja_senses where generation_id is not null"
  ).get()?.count ?? 0;
  db.close();
  expect(written).toBe(1);
  return path;
}

test("a deploy preserves accepted enrichment and never re-bootstraps over it", async () => {
  const path = enrichedStore();

  // The whole startup sequence, in the order `db:prepare` runs it. A download
  // here would be a network call the test never permits, so the assertion that
  // nothing was installed is also the assertion that nothing was fetched.
  const installed = await ensureJapaneseProductionDatabase(path);
  migrateProductionDatabase(path);
  const removedGerman = removeImportedGerman(path);

  expect(installed).toBe(false);
  expect(removedGerman).toBe(0);

  const db = new Database(path, { readonly: true });
  try {
    const sense = db.query<{ id: string; generation_id: string }, []>(
      "select id, generation_id from ja_senses where lang = 'zh-tw'"
    ).get();
    expect(sense?.id).toBe("s_zh");
    // Provenance survives too: content whose generation is lost cannot be
    // published under the licence it was accepted under.
    expect(sense?.generation_id).toBe("gen1");
    expect(db.query<{ text: string }, []>(
      "select text from ja_examples where sense_id = 's_zh'"
    ).get()?.text).toBe("私はご飯を食べる。");
    // WAL is what lets the readonly lookup connection see writes the enrichment
    // connection commits, so an entry authored a second ago answers the next
    // lookup from the database rather than from another paid model run.
    expect(String(db.query<{ journal_mode: string }, []>("pragma journal_mode").get()?.journal_mode))
      .toBe("wal");
  } finally {
    db.close();
  }
});
