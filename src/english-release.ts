import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Database } from "bun:sqlite";
import {
  validateEnglishDictionary,
  visitEnglishEntries,
  type EnglishEntryGroups
} from "./english-dictionary";
import {
  englishCanonicalTables,
  englishSchemaVersion,
  readCoverage,
  type EnglishLanguageCoverage
} from "./english-schema";
import { createStoredZip } from "./stored-zip";
import type { EnglishSense } from "./english-types";

export type EnglishReleaseArtifacts = {
  sqlite: string;
  gzip: string;
  checksum: string;
  jsonl: string;
  manifest: string;
  /** One Yomitan pack per explanation language, keyed by that language. */
  yomitan: Record<string, string>;
};

const yomitanTitles: Record<string, string> = {
  en: "Yori English–English"
};

/**
 * Publishes the English product from the canonical `en_*` tables: a snapshot
 * SQLite, JSONL with one content group per explanation language, a coverage and
 * source manifest, and one deterministic Yomitan pack per language. The Yomitan
 * adapter reads canonical meanings in their stored order; it never drives the
 * schema and never flattens two languages into one pack.
 */
export async function buildEnglishRelease(
  productionPath: string,
  options: { outputDirectory: string; version?: string }
): Promise<EnglishReleaseArtifacts> {
  const production = Bun.file(productionPath);
  if (!(await production.exists())) throw new Error(`English database does not exist: ${productionPath}`);
  await mkdir(options.outputDirectory, { recursive: true });

  const metadata = readMetadata(productionPath);
  const version = options.version ?? metadata.dictionaryVersion ?? "unknown";
  const base = `yori-english-${version}`;
  const artifacts: EnglishReleaseArtifacts = {
    sqlite: join(options.outputDirectory, `${base}.sqlite`),
    gzip: join(options.outputDirectory, `${base}.sqlite.gz`),
    checksum: join(options.outputDirectory, `${base}.sqlite.gz.sha256`),
    jsonl: join(options.outputDirectory, `${base}.jsonl`),
    manifest: join(options.outputDirectory, `${base}.json`),
    yomitan: {}
  };
  await Promise.all([
    artifacts.sqlite, artifacts.gzip, artifacts.checksum, artifacts.jsonl, artifacts.manifest
  ].map((path) => rm(path, { force: true })));

  snapshotEnglishDatabase(productionPath, artifacts.sqlite);
  const coverage = readReleaseCoverage(artifacts.sqlite);
  for (const lang of Object.keys(coverage)) {
    artifacts.yomitan[lang] = join(options.outputDirectory, `yori-en-${lang}.zip`);
    await rm(artifacts.yomitan[lang], { force: true });
  }

  // Each pack accumulates only the terms of its own explanation language, so
  // one pass over the canonical data can never place a gloss in another
  // language's pack.
  const banks = new Map<string, unknown[][][]>(Object.keys(coverage).map((lang) => [lang, [[]]]));
  const sequence = new Map<string, number>(Object.keys(coverage).map((lang) => [lang, 0]));
  const writer = Bun.file(artifacts.jsonl).writer();
  const problems: string[] = [];
  let entries = 0;

  visitEnglishEntries(artifacts.sqlite, (record) => {
    problems.push(...validateEnglishDictionary([record]));
    writer.write(`${JSON.stringify(canonicalRecord(record))}\n`);
    entries += 1;
    for (const group of record.groups) {
      const langBanks = banks.get(group.lang);
      if (!langBanks) continue;
      let bank = langBanks.at(-1)!;
      if (bank.length === 10_000) {
        bank = [];
        langBanks.push(bank);
      }
      const next = (sequence.get(group.lang) ?? 0) + 1;
      sequence.set(group.lang, next);
      bank.push([
        record.entry.headword,
        "",
        [...new Set(group.senses.map(({ partOfSpeech }) => partOfSpeech))].join(" "),
        "",
        0,
        // Meanings keep this language's own stored order.
        group.senses.flatMap((sense) => sense.glosses.map((gloss) => gloss.text)),
        next,
        ""
      ]);
    }
  });
  await writer.end();
  if (problems.length > 0) throw new Error(`Invalid English dictionary:\n${problems.slice(0, 20).join("\n")}`);

  for (const [lang, langBanks] of banks) {
    await Bun.write(artifacts.yomitan[lang], createStoredZip([
      {
        name: "index.json",
        content: JSON.stringify({
          title: yomitanTitles[lang] ?? `Yori English (${lang})`,
          revision: version,
          format: 3,
          sequenced: true,
          author: "YoriJP",
          url: "https://github.com/YoriJP/yori-dict",
          attribution: "Open English WordNet and Simple English Wiktionary contributors; see the release manifest.",
          // Named explanation language of this pack; it contains no other.
          description: `English headwords explained in ${lang}.`
        })
      },
      ...langBanks.map((bank, index) => ({ name: `term_bank_${index + 1}.json`, content: JSON.stringify(bank) }))
    ]));
  }

  await pipeline(createReadStream(artifacts.sqlite), createGzip({ level: 9 }), createWriteStream(artifacts.gzip));
  const sha256 = await fileSha256(artifacts.gzip);
  await writeFile(artifacts.checksum, `${sha256}  ${basename(artifacts.gzip)}\n`);
  const sqliteStats = await stat(artifacts.sqlite);
  const gzipStats = await stat(artifacts.gzip);
  await writeFile(artifacts.manifest, `${JSON.stringify({
    dictionary: "en",
    artifact: basename(artifacts.gzip),
    checksum: basename(artifacts.checksum),
    jsonl: basename(artifacts.jsonl),
    yomitan: Object.fromEntries(
      Object.entries(artifacts.yomitan).map(([lang, path]) => [lang, basename(path)])
    ),
    sha256,
    sqliteBytes: sqliteStats.size,
    gzipBytes: gzipStats.size,
    artifactVersion: version,
    schemaVersion: englishSchemaVersion,
    dictionaryVersion: metadata.dictionaryVersion,
    sourcePolicy: metadata.sourcePolicy,
    entries,
    coverage,
    sources: metadata.sources
  }, null, 2)}\n`);
  return artifacts;
}

/**
 * One canonical record per entry: shared identity, written form, pronunciations
 * and concise sources, then one sibling group per explanation language with
 * that language's own ordered meanings, glosses, examples and provenance.
 */
function canonicalRecord(record: EnglishEntryGroups) {
  return {
    ...record.entry,
    languages: Object.fromEntries(record.groups.map((group) => [
      group.lang,
      { meanings: group.senses.map(releaseMeaning) }
    ]))
  };
}

function releaseMeaning(sense: EnglishSense) {
  const { evidenceIds, examples, ...rest } = sense;
  return { ...rest, sources: evidenceIds, examples };
}

function readReleaseCoverage(path: string): Record<string, EnglishLanguageCoverage> {
  const db = new Database(path, { readonly: true });
  try {
    return readCoverage(db);
  } finally {
    db.close();
  }
}

function snapshotEnglishDatabase(productionPath: string, outputPath: string): void {
  const source = new Database(productionPath);
  try {
    source.exec("pragma wal_checkpoint(passive)");
    source.prepare("vacuum into ?").run(resolve(outputPath));
  } finally {
    source.close();
  }
  const snapshot = new Database(outputPath);
  try {
    // A release carries the canonical English tables and nothing else: no
    // Japanese data, no enrichment bookkeeping, and no raw source payloads.
    const keep = new Set<string>(englishCanonicalTables);
    const extra = snapshot.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
    ).all().filter(({ name }) => !keep.has(name));
    for (const { name } of extra) snapshot.exec(`drop table "${name.replaceAll('"', '""')}"`);
    snapshot.exec("pragma journal_mode = delete; vacuum");
  } finally {
    snapshot.close();
  }
}

function readMetadata(path: string) {
  const db = new Database(path, { readonly: true });
  const value = (key: string) => db.query<{ value: string }, [string]>(
    "select value from en_metadata where key = ?"
  ).get(key)?.value ?? null;
  try {
    const sources = value("sources");
    const policy = value("sourcePolicy");
    return {
      dictionaryVersion: value("dictionaryVersion"),
      sources: sources ? (JSON.parse(sources) as unknown[]) : [],
      sourcePolicy: policy ? (JSON.parse(policy) as unknown) : null
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
