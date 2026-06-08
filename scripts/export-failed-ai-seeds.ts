import { dirname } from "node:path";
import { formatJsonl } from "./ai-gloss-validation";
import { readJsonl, type AiSeed } from "./ai-common";

type Args = {
  manifestPath: string;
  outPath: string;
};

type Manifest = {
  seedPath: string;
  failuresPath: string;
};

type FailureRow = {
  key?: string | null;
  reason?: string;
};

const args = parseArgs(Bun.argv.slice(2));
const manifest = JSON.parse(await Bun.file(args.manifestPath).text()) as Manifest;
const seeds = new Map((await readJsonl<AiSeed>(manifest.seedPath)).map((seed) => [seed.senseId, seed]));
const failures = await readJsonl<FailureRow>(manifest.failuresPath);
const failedSeeds: AiSeed[] = [];
const missingKeys: string[] = [];
const seen = new Set<string>();

for (const failure of failures) {
  const key = failure.key;
  if (!key || seen.has(key)) continue;
  seen.add(key);

  const seed = seeds.get(key);
  if (!seed) {
    missingKeys.push(key);
    continue;
  }

  failedSeeds.push(seed);
}

if (missingKeys.length > 0) {
  throw new Error(`Failed keys were not found in ${manifest.seedPath}: ${missingKeys.join(", ")}`);
}

await Bun.$`mkdir -p ${dirname(args.outPath)}`;
await Bun.write(args.outPath, formatJsonl(failedSeeds));

console.log(`Exported ${failedSeeds.length} failed seed(s) to ${args.outPath}`);

function parseArgs(argv: string[]): Args {
  const manifestPath = readFlag(argv, "--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required");
  }

  return {
    manifestPath,
    outPath: readFlag(argv, "--out") ?? "data/ai-seeds/failed-seeds.jsonl"
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}
