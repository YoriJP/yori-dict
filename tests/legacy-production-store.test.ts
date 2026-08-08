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
function legacyStore(path: string, generatedEntries: number): void {
  const db = new Database(path, { create: true });
  db.exec(`
    create table metadata (key text primary key, value text not null);
    create table japanese_generated_records (
      entry_id text primary key, entry_json text not null, accepted_at text not null
    );
    insert into metadata (key, value) values ('dictDate', '2026-06-08');
  `);
  for (let index = 0; index < generatedEntries; index += 1) {
    db.prepare("insert into japanese_generated_records values (?, ?, ?)")
      .run(`yori:e_generated_${index}`, "{}", "2026-08-08T00:00:00.000Z");
  }
  db.close();
}

test("a legacy store holding accepted enrichment is refused, not replaced", () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-legacy-")), "yori.sqlite");
  legacyStore(path, 2);

  expect(() => clearReplaceableLegacyStore(path)).toThrow(
    /predates the ja-2 canonical schema and holds 2 accepted generated Japanese entries/
  );
  // The database it refused to migrate is still there to export from.
  expect(existsSync(path)).toBe(true);
});

test("a legacy store with nothing to lose is cleared so the release can bootstrap", () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-legacy-empty-")), "yori.sqlite");
  legacyStore(path, 0);

  clearReplaceableLegacyStore(path);
  expect(existsSync(path)).toBe(false);
});
