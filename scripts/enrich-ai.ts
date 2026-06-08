import { dirname } from "node:path";
import {
  candidateFromGlosses,
  candidateFromResponse,
  defaultGeminiModel,
  makeGenerateContentRequest,
  readJsonl,
  type AiSeed,
  type Candidate,
  type GeminiResponse
} from "./ai-common";

type Args = {
  inputPath: string;
  outPath: string;
  model: string;
  limit: number | null;
  dryRun: boolean;
};

const args = parseArgs(Bun.argv.slice(2));
const seeds = (await readJsonl<AiSeed>(args.inputPath)).slice(0, args.limit ?? undefined);

if (seeds.length === 0) {
  throw new Error(`No seeds found in ${args.inputPath}`);
}

await Bun.$`mkdir -p ${dirname(args.outPath)}`;

if (args.dryRun) {
  await Bun.write(args.outPath, seeds.map((seed) => JSON.stringify(toDryRunCandidate(seed, args.model))).join("\n") + "\n");
  console.log(`Wrote ${seeds.length} dry-run candidate(s) to ${args.outPath}`);
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is required unless --dry-run is used");
}

const output = Bun.file(args.outPath).writer();
let count = 0;

for (const seed of seeds) {
  const candidate = await generateCandidate(seed, args.model, apiKey);
  output.write(`${JSON.stringify(candidate)}\n`);
  count += 1;
}

output.end();
console.log(`Wrote ${count} candidate(s) to ${args.outPath}`);

function parseArgs(argv: string[]): Args {
  return {
    inputPath: readFlag(argv, "--input") ?? "data/ai-seeds/zh-tw-seeds.jsonl",
    outPath: readFlag(argv, "--out") ?? "data/ai-candidates/zh-tw-candidates.jsonl",
    model: readFlag(argv, "--model") ?? process.env.GEMINI_MODEL ?? defaultGeminiModel,
    limit: readFlag(argv, "--limit") ? parsePositiveInt(readFlag(argv, "--limit") as string) : null,
    dryRun: argv.includes("--dry-run")
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

async function generateCandidate(seed: AiSeed, model: string, apiKey: string): Promise<Candidate> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(makeGenerateContentRequest(seed))
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  const body = (await response.json()) as GeminiResponse;
  return candidateFromResponse(seed, model, body);
}

function toDryRunCandidate(seed: AiSeed, model: string): Candidate {
  return candidateFromGlosses(seed, model, []);
}
