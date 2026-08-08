import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureCachedArchive, readCacheMetadata } from "./english-evidence-cache";
import {
  filterEnglishEvidence,
  type ArchiveIdentity,
  type CorroborationIndex,
  type EvidenceCorroboration,
  type EvidenceManifest,
  type HttpMetadata,
  type MappedSourceMeta
} from "./english-evidence";
import {
  importJapaneseWordNetEvidence,
  importTaiwanTerminology,
  japaneseWordNetCorroborationIndex,
  taiwanCorroborationIndex,
  type IliMapping,
  type JapaneseWordNetRecord,
  type TaiwanTerminologyRecord
} from "./english-evidence-sources";

export type EvidenceLock = {
  schemaVersion: 1;
  source: string;
  edition: string;
  version: string;
  url: string;
  cache: string;
  sha256: string | null;
  license: string;
  attribution: string;
  mappedSources?: {
    japaneseWordNet?: {
      version: string;
      license: string;
      attribution: string;
      mappingSource: string;
      mappingVersion: string;
      records: string;
      mappings: string;
    };
    taiwanTerminology?: {
      license: string;
      records: string;
    };
  };
};

const flushThreshold = 4 * 1024 * 1024;

export type BuildArgs = {
  lockPath: string;
  archivePath: string | null;
  outDir: string;
  maxRows: number;
  maxRowsPerEntry: number;
  allowDownload: boolean;
};

if (import.meta.main) {
  const manifest = await buildEnglishEvidenceArtifacts(parseArgs(Bun.argv.slice(2)));
  console.log(JSON.stringify(manifest.coverage, null, 2));
  console.log(`Archive sha256: ${manifest.upstream.sha256}`);
  console.log(`Evidence rows: ${manifest.evidence.rows} (sha256 ${manifest.evidence.sha256})`);
}

export async function buildEnglishEvidenceArtifacts(args: BuildArgs): Promise<EvidenceManifest> {
  const lock = (await Bun.file(resolve(args.lockPath)).json()) as EvidenceLock;
  const outDir = resolve(args.outDir);
  await mkdir(outDir, { recursive: true });

  const { archivePath, http } = await resolveArchive(lock, args);
  const mapped = await loadMappedSources(lock);

  const identity: ArchiveIdentity = {
    source: lock.source,
    edition: lock.edition,
    version: lock.version,
    url: lock.url,
    license: lock.license,
    attribution: lock.attribution,
    expectedSha256: lock.sha256,
    http
  };

  const evidenceFileName = `${lock.source}-${lock.edition}-${lock.version}-ja-zh.jsonl`;
  const evidencePath = join(outDir, evidenceFileName);
  // The archive checksum is only known once the whole stream has been read, so
  // rows are staged beside the artifact and moved into place after the manifest
  // is complete. A failed run leaves the previously verified evidence and its
  // manifest as they were, rather than replacing one of the pair.
  const stagingPath = `${evidencePath}.partial`;
  const sink = Bun.file(stagingPath).writer();
  let pending = 0;

  let manifest: EvidenceManifest;
  try {
    manifest = await filterEnglishEvidence(
      Bun.file(archivePath).stream(),
      {
        identity,
        evidenceFileName,
        gzip: archivePath.endsWith(".gz"),
        maxRows: args.maxRows,
        maxRowsPerEntry: args.maxRowsPerEntry,
        corroboration: mapped.corroboration,
        mappedSources: mapped.meta
      },
      async (_row, line) => {
        pending += await sink.write(line);
        // Keep the writer's buffer bounded on a full-archive run.
        if (pending >= flushThreshold) {
          await sink.flush();
          pending = 0;
        }
      }
    );
  } catch (error) {
    await sink.end();
    await rm(stagingPath, { force: true });
    throw error;
  }
  await sink.end();

  await rename(stagingPath, evidencePath);
  await Bun.write(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!lock.sha256) {
    console.warn(`Lock ${args.lockPath} has no pinned sha256. Record ${manifest.upstream.sha256} to pin this archive.`);
  }
  return manifest;
}

async function resolveArchive(
  lock: EvidenceLock,
  args: BuildArgs
): Promise<{ archivePath: string; http: HttpMetadata | null }> {
  if (args.archivePath) {
    return { archivePath: resolve(args.archivePath), http: await readCacheMetadata(`${resolve(args.archivePath)}.meta.json`) };
  }

  const cachePath = resolve(lock.cache);
  if (!args.allowDownload) {
    if (!(await Bun.file(cachePath).exists())) {
      throw new Error(`Missing archive cache ${cachePath}. Run without --no-download or pass --archive.`);
    }
    return { archivePath: cachePath, http: await readCacheMetadata(`${cachePath}.meta.json`) };
  }

  const cached = await ensureCachedArchive(lock.url, cachePath);
  return { archivePath: cached.path, http: cached.http };
}

async function loadMappedSources(lock: EvidenceLock): Promise<{
  corroboration: CorroborationIndex;
  meta: MappedSourceMeta[];
}> {
  const meta: MappedSourceMeta[] = [];
  const japaneseTerms = new Map<string, EvidenceCorroboration>();
  const taiwanTerms = new Map<string, EvidenceCorroboration>();

  const wordNetConfig = lock.mappedSources?.japaneseWordNet;
  if (wordNetConfig && (await bothExist(wordNetConfig.records, wordNetConfig.mappings))) {
    const records = await readJsonl<JapaneseWordNetRecord>(wordNetConfig.records);
    const mappings = await readJsonl<IliMapping>(wordNetConfig.mappings);
    const imported = importJapaneseWordNetEvidence(records, mappings, wordNetConfig);
    for (const [term, corroboration] of japaneseWordNetCorroborationIndex(imported.accepted)) {
      japaneseTerms.set(term, corroboration);
    }
    meta.push(imported.meta);
    if (imported.rejected.length > 0) {
      console.warn(`Japanese WordNet: skipped ${imported.rejected.length} record(s) without a validated PWN/ILI mapping.`);
    }
  }

  const taiwanConfig = lock.mappedSources?.taiwanTerminology;
  if (taiwanConfig && (await bothExist(taiwanConfig.records))) {
    const records = await readJsonl<TaiwanTerminologyRecord>(taiwanConfig.records);
    const imported = importTaiwanTerminology(records, { license: taiwanConfig.license });
    for (const [term, corroboration] of taiwanCorroborationIndex(imported.accepted)) {
      taiwanTerms.set(term, corroboration);
    }
    meta.push(imported.meta);
    if (imported.rejected.length > 0) {
      console.warn(`Taiwan terminology: skipped ${imported.rejected.length} record(s) with incomplete provenance.`);
    }
  }

  return { corroboration: { japaneseTerms, taiwanTerms }, meta };
}

/**
 * Mapped source files are operator-supplied downloads, not committed data. A
 * configured but absent file is skipped so the Wiktionary filter still runs.
 */
async function bothExist(...paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (!(await Bun.file(resolve(path)).exists())) {
      console.warn(`Skipping mapped source: ${path} is not present.`);
      return false;
    }
  }
  return true;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(resolve(path)).text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function parseArgs(argv: string[]): BuildArgs {
  return {
    lockPath: flag(argv, "--lock") ?? "sources/english/wiktionary-full-lock.json",
    archivePath: flag(argv, "--archive"),
    outDir: flag(argv, "--out-dir") ?? "sources/english/evidence",
    maxRows: positiveInt(flag(argv, "--max-rows") ?? "500000", "--max-rows"),
    maxRowsPerEntry: positiveInt(flag(argv, "--max-rows-per-entry") ?? "24", "--max-rows-per-entry"),
    allowDownload: !argv.includes("--no-download")
  };
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
