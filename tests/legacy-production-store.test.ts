import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearReplaceableLegacyStore } from "../src/production-database";

/**
 * A volume written before the `ja_*` rebuild: its Japanese version lives in
 * `metadata`, and any accepted enrichment in `japanese_generated_records`.
 */
type LegacyContent = Partial<Record<"japaneseEntry" | "japaneseExample" | "englishEntry" | "englishExample", boolean>>;

function legacyStore(path: string, holds: LegacyContent = {}): void {
  const db = new Database(path, { create: true });
  db.exec(`
    create table metadata (key text primary key, value text not null);
    create table japanese_generated_records (
      entry_id text primary key, entry_json text not null, accepted_at text not null
    );
    create table examples (sense_id text, position integer, text text, source text);
    create table english_entries (id text primary key, headword text, lookup_term text, entry_json text);
    create table english_imported_entries (entry_id text primary key);
    create table english_examples (sense_id text primary key, entry_id text, example_json text);
    insert into metadata (key, value) values ('dictDate', '2026-06-08');
    -- An imported English entry is not enrichment and must not hold a start.
    insert into english_entries values ('yori:en:e_imported', 'bank', 'bank', '{}');
    insert into english_imported_entries values ('yori:en:e_imported');
    -- Nor is a sourced example on an imported Japanese meaning.
    insert into examples values ('yori:s_jmdict_1_1', 1, 'sourced', 'sourced');
  `);
  if (holds.japaneseEntry) {
    db.prepare("insert into japanese_generated_records values (?, ?, ?)")
      .run("yori:e_generated_1", "{}", "2026-08-08T00:00:00.000Z");
  }
  if (holds.japaneseExample) {
    db.prepare("insert into examples values (?, ?, ?, ?)").run("yori:s_jmdict_1_1", 2, "generated", "generated");
  }
  if (holds.englishEntry) {
    db.prepare("insert into english_entries values (?, ?, ?, ?)").run("yori:en:e_authored", "florp", "florp", "{}");
  }
  if (holds.englishExample) {
    db.prepare("insert into english_examples values (?, ?, ?)").run("yori:en:s_1", "yori:en:e_imported", "{}");
  }
  db.close();
}

const acceptedContent = [
  ["an authored Japanese entry", { japaneseEntry: true }, /1 Japanese entries/],
  ["a generated Japanese example", { japaneseExample: true }, /1 Japanese examples/],
  ["an authored English entry", { englishEntry: true }, /1 English entries/],
  ["a generated English example", { englishExample: true }, /1 English examples/]
] as const;

for (const [what, holds, message] of acceptedContent) {
  test(`a legacy store holding ${what} is refused, not replaced`, () => {
    const path = join(mkdtempSync(join(tmpdir(), "yori-legacy-")), "yori.sqlite");
    legacyStore(path, holds);

    expect(() => clearReplaceableLegacyStore(path)).toThrow(message);
    // The database it refused to migrate is still there to export from.
    expect(existsSync(path)).toBe(true);
  });
}

test("a legacy store with nothing to lose is cleared so the release can bootstrap", () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-legacy-empty-")), "yori.sqlite");
  // It still holds imported content, which the pinned sources reproduce.
  legacyStore(path);

  clearReplaceableLegacyStore(path);
  expect(existsSync(path)).toBe(false);
});
