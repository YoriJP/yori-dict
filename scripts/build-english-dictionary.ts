import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildEnglishRelease } from "../src/english-release";
import { importOpenEnglishWordNet, importWiktionaryEntry } from "../src/english-import";
import type { EnglishSourceRecord } from "../src/english-types";

const lockPath = resolve(flag("--lock") ?? "sources/english/source-lock.json");
const outputDirectory = resolve(flag("--out-dir") ?? "releases/english");
const version = flag("--version");
if (!version) throw new Error("--version is required so English releases remain independent and explicit");

const lock = await Bun.file(lockPath).json() as SourceLock;
const records: EnglishSourceRecord[] = [];
for (const source of lock.sources) {
  const path = resolve(source.file);
  await verifyChecksum(path, source.sha256);
  console.log(`Importing ${source.source} ${source.version}...`);
  if (source.source === "open-english-wordnet") {
    const extractionDirectory = await mkdtemp(join(tmpdir(), "yori-oewn-"));
    try {
      await Bun.$`unzip -q ${path} -d ${extractionDirectory}`;
      const names = (await readdir(extractionDirectory))
        .filter((name) => /^(noun|verb|adv|adj)\..+\.json$/.test(name) && !name.startsWith("entries-"))
        .sort();
      for (const name of names) {
        const document = await Bun.file(join(extractionDirectory, name)).json() as Record<string, unknown>;
        records.push(...importOpenEnglishWordNet(document, source.version));
      }
    } finally {
      await rm(extractionDirectory, { recursive: true, force: true });
    }
  } else {
    const text = await gunzipText(path);
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      records.push(...importWiktionaryEntry(JSON.parse(line), source.version, {
        attribution: source.attribution,
        recordIdSuffix: `line-${index + 1}`
      }));
    }
  }
  console.log(`Imported ${records.length.toLocaleString()} source records so far.`);
}

console.log(`Reconciling and packaging ${records.length.toLocaleString()} source records...`);
const artifacts = await buildEnglishRelease(records, {
  outputDirectory,
  version,
  createdAt: lock.releaseCreatedAt
});
console.log(JSON.stringify({ records: records.length, artifacts }, null, 2));

async function verifyChecksum(path: string, expected: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Missing committed English source input: ${path}`);
  const actual = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
}

async function gunzipText(path: string): Promise<string> {
  const stream = Bun.file(path).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

type SourceLock = {
  schemaVersion: 1;
  releaseCreatedAt: string;
  sources: Array<{
    source: "open-english-wordnet" | "wiktionary";
    version: string;
    file: string;
    sha256: string;
    attribution: string;
  }>;
};
