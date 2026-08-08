import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  rebuildEnglishDictionary,
  type EnglishLanguageSourceInput,
  type EnglishSourceInput
} from "../src/english-rebuild";

const lockPath = resolve(flag("--lock") ?? "sources/english/source-lock.json");
const out = resolve(flag("--out") ?? process.env.YORI_DB_PATH ?? "data/yori-english.sqlite");
const version = flag("--version");
if (!version) throw new Error("--version is required so English releases remain independent and explicit");

const lock = await Bun.file(lockPath).json() as SourceLock;
const sources: EnglishSourceInput[] = [];
for (const source of lock.sources) {
  const path = resolve(source.file);
  await verifyChecksum(path, source.sha256);
  sources.push({ ...source, file: path });
}

// Sources that publish an explanation language other than English. They are
// optional: the repository does not commit Japanese WordNet or Taiwan
// terminology data, so a lock without them simply builds the English group and
// leaves the other language groups to authored content.
const languageSources: EnglishLanguageSourceInput[] = [];
for (const source of lock.languageSources ?? []) {
  const file = resolve(source.file);
  if (source.sha256) await verifyChecksum(file, source.sha256);
  if (source.source === "japanese-wordnet") {
    const mappings = resolve(source.mappings);
    if (source.mappingsSha256) await verifyChecksum(mappings, source.mappingsSha256);
    languageSources.push({ ...source, file, mappings });
  } else {
    languageSources.push({ ...source, file });
  }
}

console.log(`Rebuilding the English dictionary from ${sources.length} pinned sources...`);
const result = await rebuildEnglishDictionary({
  sources,
  out,
  version,
  ...(languageSources.length > 0 ? { languageSources } : {}),
  ...(flagList("--secondary").length > 0 ? { secondaryMappings: flagList("--secondary").map((path) => resolve(path)) } : {}),
  ...(flag("--retain-from") ? { retainFrom: resolve(flag("--retain-from")!) } : {})
});
console.log(JSON.stringify(result, null, 2));

async function verifyChecksum(path: string, expected: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Missing committed English source input: ${path}`);
  const actual = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function flagList(name: string): string[] {
  return Bun.argv.flatMap((value, index) => value === name && Bun.argv[index + 1] ? [Bun.argv[index + 1]] : []);
}

type SourceLock = {
  schemaVersion: 1;
  releaseCreatedAt: string;
  sources: Array<{
    source: "open-english-wordnet" | "wiktionary";
    version: string;
    file: string;
    sha256: string;
    url?: string;
    license?: string;
    attribution: string;
  }>;
  languageSources?: Array<
    | (Extract<EnglishLanguageSourceInput, { source: "japanese-wordnet" }> & { mappingsSha256?: string })
    | Extract<EnglishLanguageSourceInput, { source: "taiwan-terminology" }>
  >;
};
