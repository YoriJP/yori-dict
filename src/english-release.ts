import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { reconcileEnglishSourceRecords, validateEnglishDictionary } from "./english-dictionary";
import { createStoredZip } from "./stored-zip";
import type { EnglishEntry, EnglishReleaseManifest, EnglishSourceRecord } from "./english-types";

export type EnglishReleaseArtifacts = {
  sqlite: string;
  jsonl: string;
  yomitan: string;
  manifest: string;
};

export async function buildEnglishRelease(
  inputRecords: EnglishSourceRecord[],
  options: { outputDirectory: string; version: string; createdAt?: string }
): Promise<EnglishReleaseArtifacts> {
  const records = uniqueSourceRecords(inputRecords).sort((left, right) =>
    `${left.source}:${left.sourceEntryId}`.localeCompare(`${right.source}:${right.sourceEntryId}`, "en")
  );
  const entries = reconcileEnglishSourceRecords(records);
  const problems = validateEnglishDictionary(entries);
  if (problems.length > 0) throw new Error(`Invalid English dictionary:\n${problems.join("\n")}`);
  mkdirSync(options.outputDirectory, { recursive: true });
  const base = `yori-english-${options.version}`;
  const artifacts = {
    sqlite: join(options.outputDirectory, `${base}.sqlite`),
    jsonl: join(options.outputDirectory, `${base}.jsonl`),
    yomitan: join(options.outputDirectory, `${base}.yomitan.zip`),
    manifest: join(options.outputDirectory, `${base}.json`)
  };
  await Bun.write(artifacts.jsonl, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
  writeEnglishSqlite(artifacts.sqlite, entries, records, options.version);
  await Bun.write(artifacts.yomitan, englishYomitanArchive(entries, options.version));
  const manifest = releaseManifest(entries, records, artifacts, options.version, options.createdAt ?? new Date().toISOString());
  await Bun.write(artifacts.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return artifacts;
}

export function openEnglishDictionary(path: string): {
  lookup(query: string): EnglishEntry | null;
  close(): void;
} {
  const db = new Database(path, { readonly: true });
  const lookup = db.query<{ entry_json: string }, [string]>(
    "select entry_json from entries where lookup_term = ? limit 1"
  );
  return {
    lookup(query) {
      const row = lookup.get(normalizeLookup(query));
      return row ? JSON.parse(row.entry_json) as EnglishEntry : null;
    },
    close() { db.close(); }
  };
}

function writeEnglishSqlite(
  path: string,
  entries: EnglishEntry[],
  records: EnglishSourceRecord[],
  version: string
): void {
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      pragma journal_mode = off;
      pragma synchronous = off;
      create table metadata (key text primary key, value text not null);
      create table source_payloads (
        source text not null,
        payload_id text not null,
        raw_json text not null,
        primary key (source, payload_id)
      );
      create table source_records (
        source text not null,
        source_version text not null,
        source_entry_id text not null,
        headword_lookup text not null,
        license text not null,
        attribution text not null,
        payload_id text not null,
        record_json text not null,
        primary key (source, source_entry_id)
      );
      create index source_records_headword on source_records(headword_lookup);
      create table entries (
        id text primary key,
        headword text not null,
        lookup_term text not null unique,
        entry_json text not null
      );
      create table senses (
        id text primary key,
        entry_id text not null,
        position integer not null,
        part_of_speech text not null,
        definition text not null,
        sense_json text not null
      );
      create index senses_entry on senses(entry_id, position);
    `);
    const metadata = db.prepare("insert into metadata values (?, ?)");
    const payload = db.prepare("insert or ignore into source_payloads values (?, ?, ?)");
    const source = db.prepare("insert into source_records values (?, ?, ?, ?, ?, ?, ?, ?)");
    const entry = db.prepare("insert into entries values (?, ?, ?, ?)");
    const sense = db.prepare("insert into senses values (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      metadata.run("dictionary", "en");
      metadata.run("schemaVersion", "1");
      metadata.run("dictionaryVersion", version);
      for (const record of records) {
        const payloadId = sourcePayloadId(record);
        const { rawRecord: _rawRecord, ...normalizedRecord } = record;
        payload.run(record.source, payloadId, JSON.stringify(record.rawRecord));
        source.run(
          record.source, record.sourceVersion, record.sourceEntryId, normalizeLookup(record.headword),
          record.license, record.attribution, payloadId, JSON.stringify({ ...normalizedRecord, rawRecord: null })
        );
      }
      for (const item of entries) {
        entry.run(item.id, item.headword, normalizeLookup(item.headword), JSON.stringify(item));
        for (const itemSense of item.senses) {
          sense.run(itemSense.id, item.id, itemSense.position, itemSense.partOfSpeech, itemSense.definition, JSON.stringify(itemSense));
        }
      }
    })();
  } finally {
    db.close();
  }
}

function englishYomitanArchive(entries: EnglishEntry[], version: string): Uint8Array {
  const index = {
    title: "Yori English Dictionary",
    revision: version,
    format: 3,
    sequenced: true,
    author: "YoriJP",
    url: "https://github.com/YoriJP/yori-dict",
    attribution: "Open English WordNet (CC BY 4.0) and English Wiktionary (CC BY-SA 4.0 / GFDL); see release manifest."
  };
  const terms = entries.map((entry, index) => [
    entry.headword,
    "",
    [...new Set(entry.senses.map(({ partOfSpeech }) => partOfSpeech))].join(" "),
    "",
    0,
    entry.senses.map(({ definition }) => definition),
    index + 1,
    ""
  ]);
  return createStoredZip([
    { name: "index.json", content: JSON.stringify(index) },
    ...chunks(terms, 10_000).map((bank, index) => ({
      name: `term_bank_${index + 1}.json`,
      content: JSON.stringify(bank)
    }))
  ]);
}

function releaseManifest(
  entries: EnglishEntry[],
  records: EnglishSourceRecord[],
  artifacts: EnglishReleaseArtifacts,
  version: string,
  createdAt: string
): EnglishReleaseManifest {
  const sources = new Map<string, EnglishReleaseManifest["sources"][number]>();
  for (const record of records) sources.set(record.source, {
    source: record.source,
    version: record.sourceVersion,
    license: record.license,
    attribution: record.attribution
  });
  return {
    dictionary: "en",
    schemaVersion: 1,
    dictionaryVersion: version,
    createdAt,
    counts: {
      entries: entries.length,
      senses: entries.reduce((sum, entry) => sum + entry.senses.length, 0),
      sourceRecords: records.length
    },
    artifacts: {
      sqlite: artifacts.sqlite.split("/").at(-1)!,
      jsonl: artifacts.jsonl.split("/").at(-1)!,
      yomitan: artifacts.yomitan.split("/").at(-1)!
    },
    sources: Array.from(sources.values()).sort((left, right) => left.source.localeCompare(right.source))
  };
}

function normalizeLookup(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output.length > 0 ? output : [[]];
}

function uniqueSourceRecords(records: EnglishSourceRecord[]): EnglishSourceRecord[] {
  const unique = new Map<string, EnglishSourceRecord>();
  for (const record of records) {
    const key = `${record.source}:${record.sourceEntryId}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, record);
      continue;
    }
    if (JSON.stringify(existing.rawRecord) !== JSON.stringify(record.rawRecord)) {
      throw new Error(`Conflicting immutable English source record: ${key}`);
    }
  }
  return Array.from(unique.values());
}

function sourcePayloadId(record: EnglishSourceRecord): string {
  if (record.source !== "open-english-wordnet") return record.sourceEntryId;
  return record.sourceEntryId.slice(0, record.sourceEntryId.lastIndexOf(":"));
}
