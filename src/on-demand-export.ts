import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord } from "./on-demand-dictionary";
import type { PublicLookupItem } from "./types";

export type OnDemandArtifacts = {
  jsonl: string;
  sqlite: string;
  yomitan: string;
};

export async function exportOnDemandArtifacts(
  inputEntries: PublicLookupItem[],
  attempts: AttemptRecord[],
  outputDirectory: string
): Promise<OnDemandArtifacts> {
  mkdirSync(outputDirectory, { recursive: true });
  const entries = [...inputEntries].sort((left, right) => left.id.localeCompare(right.id));
  const artifacts = {
    jsonl: join(outputDirectory, "japanese.generated.jsonl"),
    sqlite: join(outputDirectory, "japanese.generated.sqlite"),
    yomitan: join(outputDirectory, "japanese.yomitan.zip")
  };

  const jsonl = entries
    .map((entry) => JSON.stringify({ entry, provenance: conciseProvenance(attemptsForEntry(entry, attempts)) }))
    .join("\n");
  await Bun.write(artifacts.jsonl, jsonl ? `${jsonl}\n` : "");
  writeSqlite(artifacts.sqlite, entries, attempts);
  await Bun.write(artifacts.yomitan, yomitanArchive(entries));
  return artifacts;
}

function conciseProvenance(attempts: AttemptRecord[]) {
  const seen = new Set<string>();
  return attempts.flatMap((attempt) => {
    const value = {
      promptVersion: attempt.promptVersion,
      model: attempt.model,
      provider: attempt.provider,
      reasoningEffort: attempt.reasoningEffort
    };
    const key = JSON.stringify(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

function attemptsForEntry(entry: PublicLookupItem, attempts: AttemptRecord[]): AttemptRecord[] {
  const sensePrefixes = entry.senses.map((sense) => `${sense.id}:`);
  return attempts.filter((attempt) =>
    !attempt.candidateId
    || attempt.candidateId === entry.id
    || sensePrefixes.some((prefix) => attempt.candidateId!.startsWith(prefix))
  );
}

function writeSqlite(path: string, entries: PublicLookupItem[], attempts: AttemptRecord[]): void {
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      pragma journal_mode = off;
      pragma synchronous = off;
      create table entries (
        id text primary key,
        headword text not null,
        reading text,
        entry_json text not null,
        provenance_json text not null
      );
      create table senses (
        id text primary key,
        entry_id text not null,
        position integer not null,
        sense_json text not null
      );
      create table glosses (
        sense_id text not null,
        position integer not null,
        lang text,
        text text not null,
        gloss_json text not null,
        primary key (sense_id, position)
      );
      create table examples (
        sense_id text not null,
        position integer not null,
        example_json text not null,
        primary key (sense_id, position)
      );
      create table attempts (
        position integer primary key,
        role text not null,
        outcome text not null,
        attempt_json text not null
      );
    `);
    const insertEntry = db.prepare(`insert into entries values (?, ?, ?, ?, ?)`);
    const insertSense = db.prepare(`insert into senses values (?, ?, ?, ?)`);
    const insertGloss = db.prepare(`insert into glosses values (?, ?, ?, ?, ?)`);
    const insertExample = db.prepare(`insert into examples values (?, ?, ?)`);
    const insertAttempt = db.prepare(`insert into attempts values (?, ?, ?, ?)`);
    db.transaction(() => {
      for (const entry of entries) {
        const provenance = JSON.stringify(conciseProvenance(attemptsForEntry(entry, attempts)));
        insertEntry.run(entry.id, entry.word, entry.reading, JSON.stringify(entry), provenance);
        for (const sense of entry.senses) {
          insertSense.run(sense.id, entry.id, sense.position, JSON.stringify(sense));
          sense.glosses.forEach((gloss, index) =>
            insertGloss.run(sense.id, index + 1, gloss.lang ?? null, gloss.text, JSON.stringify(gloss))
          );
          sense.examples?.forEach((example, index) =>
            insertExample.run(sense.id, index + 1, JSON.stringify(example))
          );
        }
      }
      attempts.forEach((attempt, index) =>
        insertAttempt.run(index + 1, attempt.role, attempt.outcome, JSON.stringify(publicAttempt(attempt)))
      );
    })();
  } finally {
    db.close();
  }
}

function publicAttempt(attempt: AttemptRecord): AttemptRecord {
  const { prompt: _prompt, response: _response, error: _error, ...metadata } = attempt;
  return metadata;
}

function yomitanArchive(entries: PublicLookupItem[]): Uint8Array {
  const index = {
    title: "Yori Japanese Dictionary",
    revision: "generated",
    format: 3,
    sequenced: true,
    author: "YoriJP",
    url: "https://github.com/YoriJP/yori-dict",
    attribution: "Generated entries are CC BY-SA 4.0; see Yori Dict provenance."
  };
  const terms = entries.map((entry, index) => {
    const english = entry.senses.flatMap((sense) =>
      sense.glosses.filter((gloss) => !gloss.lang || gloss.lang === "en").map((gloss) => gloss.text)
    );
    return [entry.word, entry.reading ?? "", "", "", 0, english, index + 1, ""];
  });
  return createStoredZip([
    { name: "index.json", content: JSON.stringify(index) },
    { name: "term_bank_1.json", content: JSON.stringify(terms) }
  ]);
}

function createStoredZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = header(30 + name.length, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, 0, true);
    });
    local.set(name, 30);
    localParts.push(local, data);

    const central = header(46 + name.length, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, 0, true);
      view.setUint16(14, 0, true);
      view.setUint32(16, crc, true);
      view.setUint32(20, data.length, true);
      view.setUint32(24, data.length, true);
      view.setUint16(28, name.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, offset, true);
    });
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    view.setUint16(20, 0, true);
  });
  return concatenate([...localParts, ...centralParts, end]);
}

function header(length: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
