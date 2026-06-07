import { dirname } from "node:path";
import type { ApiLang } from "../src/types";

type Args = {
  inputPath: string;
  outPath: string;
  model: string;
  limit: number | null;
  dryRun: boolean;
};

type AiSeed = {
  entryId: string;
  senseId: string;
  word: string;
  reading: string | null;
  common: boolean;
  position: number;
  targetLang: ApiLang;
  pos: string[];
  glosses: string[];
};

type Candidate = {
  entryId: string;
  senseId: string;
  word: string;
  reading: string | null;
  targetLang: ApiLang;
  sourceGlosses: string[];
  candidateGlosses: string[];
  model: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
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
    model: readFlag(argv, "--model") ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
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

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
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
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: promptFor(seed) }]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  const body = (await response.json()) as GeminiResponse;
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const parsed = parseGlossResponse(text);

  return {
    entryId: seed.entryId,
    senseId: seed.senseId,
    word: seed.word,
    reading: seed.reading,
    targetLang: seed.targetLang,
    sourceGlosses: seed.glosses,
    candidateGlosses: parsed.glosses,
    model
  };
}

function promptFor(seed: AiSeed): string {
  return [
    "Translate one JMdict Japanese sense into Traditional Chinese dictionary glosses.",
    "Return JSON only with this shape: {\"glosses\":[\"...\"]}.",
    "Rules:",
    "- Use Traditional Chinese used in Taiwan.",
    "- Return short dictionary glosses, not explanations.",
    "- Do not add examples.",
    "- Do not add a new sense.",
    "- Preserve the meaning of the English source glosses.",
    "",
    `Japanese word: ${seed.word}`,
    `Reading: ${seed.reading ?? ""}`,
    `Part of speech: ${seed.pos.join(", ")}`,
    `English source glosses: ${seed.glosses.join("; ")}`
  ].join("\n");
}

function parseGlossResponse(text: string): { glosses: string[] } {
  const parsed = JSON.parse(text) as { glosses?: unknown };
  if (!Array.isArray(parsed.glosses) || !parsed.glosses.every((item) => typeof item === "string")) {
    throw new Error(`Gemini returned invalid gloss JSON: ${text}`);
  }

  return {
    glosses: parsed.glosses.map((item) => item.trim()).filter(Boolean)
  };
}

function toDryRunCandidate(seed: AiSeed, model: string): Candidate {
  return {
    entryId: seed.entryId,
    senseId: seed.senseId,
    word: seed.word,
    reading: seed.reading,
    targetLang: seed.targetLang,
    sourceGlosses: seed.glosses,
    candidateGlosses: [],
    model
  };
}
