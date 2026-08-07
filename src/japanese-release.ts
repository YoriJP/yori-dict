import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Database } from "bun:sqlite";
import { visitLookupItems } from "./db";
import { createStoredZip } from "./stored-zip";

export type JapaneseReleaseArtifacts = {
  sqlite: string;
  gzip: string;
  checksum: string;
  jsonl: string;
  yomitan: string;
  manifest: string;
};

export async function buildJapaneseRelease(
  productionPath: string,
  options: { outputDirectory: string; version?: string }
): Promise<JapaneseReleaseArtifacts> {
  const production = Bun.file(productionPath);
  if (!(await production.exists())) throw new Error(`Production database does not exist: ${productionPath}`);
  await mkdir(options.outputDirectory, { recursive: true });

  const metadata = readMetadata(productionPath);
  const version = options.version ?? metadata.dictionaryVersion ?? "unknown";
  const base = `yori-dict-${version}`;
  const artifacts = {
    sqlite: join(options.outputDirectory, `${base}.sqlite`),
    gzip: join(options.outputDirectory, `${base}.sqlite.gz`),
    checksum: join(options.outputDirectory, `${base}.sqlite.gz.sha256`),
    jsonl: join(options.outputDirectory, `${base}.jsonl`),
    yomitan: join(options.outputDirectory, `${base}.yomitan.zip`),
    manifest: join(options.outputDirectory, `${base}.json`)
  };
  await Promise.all(Object.values(artifacts).map((path) => rm(path, { force: true })));

  snapshotJapaneseDatabase(productionPath, artifacts.sqlite);
  const writer = Bun.file(artifacts.jsonl).writer();
  const banks: unknown[][][] = [[]];
  let entries = 0;
  let senses = 0;
  visitLookupItems(artifacts.sqlite, (entry) => {
    writer.write(`${JSON.stringify(entry)}\n`);
    entries += 1;
    senses += entry.senses.length;
    let bank = banks.at(-1)!;
    if (bank.length === 10_000) {
      bank = [];
      banks.push(bank);
    }
    const english = entry.senses.flatMap((sense) =>
      sense.glosses.filter((gloss) => !gloss.lang || gloss.lang === "en").map((gloss) => gloss.text)
    );
    bank.push([entry.word, entry.reading ?? "", "", "", 0, english, entries, ""]);
  });
  await writer.end();

  await Bun.write(artifacts.yomitan, createStoredZip([
    {
      name: "index.json",
      content: JSON.stringify({
        title: "Yori Japanese Dictionary",
        revision: version,
        format: 3,
        sequenced: true,
        author: "YoriJP",
        url: "https://github.com/YoriJP/yori-dict",
        attribution: "JMdict and Yori Dict contributors; see the release manifest."
      })
    },
    ...banks.map((bank, index) => ({ name: `term_bank_${index + 1}.json`, content: JSON.stringify(bank) }))
  ]));
  await pipeline(createReadStream(artifacts.sqlite), createGzip({ level: 9 }), createWriteStream(artifacts.gzip));
  const sha256 = await fileSha256(artifacts.gzip);
  await writeFile(artifacts.checksum, `${sha256}  ${basename(artifacts.gzip)}\n`);
  const sqliteStats = await stat(artifacts.sqlite);
  const gzipStats = await stat(artifacts.gzip);
  await writeFile(artifacts.manifest, `${JSON.stringify({
    artifact: basename(artifacts.gzip),
    checksum: basename(artifacts.checksum),
    jsonl: basename(artifacts.jsonl),
    yomitan: basename(artifacts.yomitan),
    sha256,
    sqliteBytes: sqliteStats.size,
    gzipBytes: gzipStats.size,
    artifactVersion: version,
    dictionaryVersion: metadata.dictionaryVersion,
    jmdictSimplifiedVersion: metadata.jmdictSimplifiedVersion,
    counts: { ...metadata.counts, entries, senses },
    sources: japaneseSources
  }, null, 2)}\n`);
  return artifacts;
}

function snapshotJapaneseDatabase(productionPath: string, outputPath: string): void {
  const source = new Database(productionPath);
  try {
    source.exec("pragma wal_checkpoint(passive)");
    source.prepare("vacuum into ?").run(resolve(outputPath));
  } finally {
    source.close();
  }
  const snapshot = new Database(outputPath);
  try {
    const internal = snapshot.query<{ name: string }, []>(`
      select name from sqlite_master
       where type = 'table'
         and (name like 'english_%'
           or name in ('production_metadata', 'model_attempts', 'terminal_outcomes', '__drizzle_migrations'))
    `).all();
    for (const { name } of internal) snapshot.exec(`drop table "${name.replaceAll('"', '""')}"`);
    snapshot.exec("pragma journal_mode = delete; vacuum");
  } finally {
    snapshot.close();
  }
}

function readMetadata(path: string) {
  const db = new Database(path, { readonly: true });
  const value = (key: string) => db.query<{ value: string }, [string]>(
    "select value from metadata where key = ?"
  ).get(key)?.value ?? null;
  const count = (sql: string) => db.query<{ count: number }, []>(sql).get()?.count ?? 0;
  try {
    return {
      dictionaryVersion: value("dictDate"),
      jmdictSimplifiedVersion: value("jmdictSimplifiedVersion"),
      counts: {
        glosses: count("select count(*) as count from glosses"),
        generatedLegacyGlosses: count("select count(*) as count from glosses where source = 'ai-assisted'"),
        sourcedExamples: count("select count(*) as count from examples where source = 'sourced'"),
        generatedExamples: count("select count(*) as count from examples where source = 'generated'"),
        estimatedLevels: count("select count(*) as count from entries where estimated_level is not null")
      }
    };
  } finally {
    db.close();
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const japaneseSources = [
  { name: "JMdict", license: "CC-BY-SA-4.0", url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" },
  { name: "Tatoeba example sentences", license: "CC-BY-2.0-FR", url: "https://tatoeba.org/en/terms_of_use" },
  { name: "yomitan-jlpt-vocab", license: "CC-BY-SA-4.0", url: "https://github.com/stephenmk/yomitan-jlpt-vocab" },
  { name: "Yori generated dictionary content", license: "CC-BY-SA-4.0" }
];
