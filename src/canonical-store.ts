import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * What the Japanese and English dictionaries genuinely share.
 *
 * The two dictionaries are separate products with separate physical tables,
 * so nothing here knows a table name or an explanation language. What lives
 * here is the machinery both rebuilds and both releases need: coverage counted
 * the same way, a canonical snapshot stripped of everything but its own
 * tables, checksums, and row copying.
 */

/** Per-explanation-language counts, the unit every manifest reports. */
export type LanguageCoverage = {
  entries: number;
  senses: number;
  glosses: number;
  examples: number;
};

/**
 * Coverage for one dictionary's canonical tables, keyed by explanation
 * language. Language lives on senses, so glosses and examples are counted
 * through the sense that owns them.
 */
export function readLanguageCoverage(db: Database, prefix: string): Record<string, LanguageCoverage> {
  const rows = db.query<{ lang: string } & LanguageCoverage, []>(`
    select sense.lang as lang,
           count(distinct sense.entry_id) as entries,
           count(distinct sense.id) as senses,
           (select count(*) from ${prefix}_glosses g
              join ${prefix}_senses s on s.id = g.sense_id where s.lang = sense.lang) as glosses,
           (select count(*) from ${prefix}_examples e
              join ${prefix}_senses s on s.id = e.sense_id where s.lang = sense.lang) as examples
      from ${prefix}_senses sense
     group by sense.lang
     order by sense.lang
  `).all();
  return Object.fromEntries(rows.map(({ lang, ...counts }) => [lang, counts]));
}

/** Coverage read from a database file that is not already open. */
export function readCoverageFrom(path: string, prefix: string): Record<string, LanguageCoverage> {
  const db = new Database(path, { readonly: true });
  try {
    return readLanguageCoverage(db, prefix);
  } finally {
    db.close();
  }
}

/**
 * Copies a production database into a release file holding one dictionary's
 * canonical tables and nothing else: no other dictionary's data, no enrichment
 * bookkeeping, and no raw source payloads.
 */
export function snapshotCanonicalDatabase(
  productionPath: string,
  outputPath: string,
  canonicalTables: readonly string[]
): void {
  const source = new Database(productionPath);
  try {
    source.exec("pragma wal_checkpoint(passive)");
    source.prepare("vacuum into ?").run(resolve(outputPath));
  } finally {
    source.close();
  }
  const snapshot = new Database(outputPath);
  try {
    const keep = new Set<string>(canonicalTables);
    const extra = snapshot.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
    ).all().filter(({ name }) => !keep.has(name));
    for (const { name } of extra) snapshot.exec(`drop table "${name.replaceAll('"', '""')}"`);
    snapshot.exec("pragma journal_mode = delete; vacuum");
  } finally {
    snapshot.close();
  }
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** A database and the sidecar files SQLite writes beside it. */
export async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) => rm(file, { force: true })));
}

/** Copies one retained row back into a rebuilt table, column for column. */
export function insertRow(
  db: Database,
  table: string,
  row: Record<string, unknown>,
  ignore: boolean
): void {
  const columns = Object.keys(row);
  db.prepare(
    `insert ${ignore ? "or ignore " : ""}into ${table} (${columns.join(", ")})
     values (${columns.map(() => "?").join(", ")})`
  ).run(...columns.map((column) => row[column] as never));
}
