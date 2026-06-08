import { readJsonl } from "./ai-common";
import type { AiGlossSource } from "./ai-gloss-validation";

type Args = {
  manifestPath: string;
  rejectedPath: string | null;
  sourcePath: string;
};

type Manifest = {
  seedPath: string;
  outPath: string;
  failuresPath: string;
};

type KeyedRow = {
  key?: string | null;
  senseId?: string;
};

const args = parseArgs(Bun.argv.slice(2));
const manifest = JSON.parse(await Bun.file(args.manifestPath).text()) as Manifest;
const rejectedPath = args.rejectedPath ?? inferRejectedPath(manifest.outPath);

const submitted = await safeCountJsonl(manifest.seedPath);
const candidates = await safeReadJsonl<KeyedRow>(manifest.outPath);
const failures = await safeReadJsonl<KeyedRow>(manifest.failuresPath);
const rejected = await safeReadJsonl<KeyedRow>(rejectedPath);
const sourceRows = await safeReadJsonl<AiGlossSource>(args.sourcePath);

const candidateKeys = new Set(candidates.map((row) => row.senseId).filter((key): key is string => typeof key === "string"));
const failureCount = failures.length;
const rejectedCount = rejected.length;
const acceptedThisRun = sourceRows.filter((row) => candidateKeys.has(row.senseId)).length;
const unaccounted = Math.max(candidates.length - acceptedThisRun - rejectedCount, 0);

console.log(`manifest: ${args.manifestPath}`);
console.log(`submitted: ${submitted}`);
console.log(`candidates: ${candidates.length}`);
console.log(`accepted: ${acceptedThisRun}`);
console.log(`rejected: ${rejectedCount}`);
console.log(`failed: ${failureCount}`);
if (unaccounted > 0) console.log(`unaccountedCandidates: ${unaccounted}`);
console.log(`sourceTotal: ${sourceRows.length}`);
console.log(`candidatePath: ${manifest.outPath}`);
console.log(`rejectedPath: ${rejectedPath}`);
console.log(`failuresPath: ${manifest.failuresPath}`);

function parseArgs(argv: string[]): Args {
  const manifestPath = readFlag(argv, "--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required");
  }

  return {
    manifestPath,
    rejectedPath: readFlag(argv, "--rejected"),
    sourcePath: readFlag(argv, "--source") ?? "sources/ai-glosses/zh-tw.jsonl"
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function safeReadJsonl<T>(path: string): Promise<T[]> {
  if (!(await Bun.file(path).exists())) return [];
  return await readJsonl<T>(path);
}

async function safeCountJsonl(path: string): Promise<number> {
  return (await safeReadJsonl<unknown>(path)).length;
}

function inferRejectedPath(candidatePath: string): string {
  return candidatePath.replace(/-candidates\.jsonl$/, "-rejected.jsonl").replace(/candidates\.jsonl$/, "rejected.jsonl");
}
