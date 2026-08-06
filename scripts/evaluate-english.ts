import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeEnglishReviewerEvaluation, type EnglishReviewerJudgment } from "../src/english-evaluation";
import { createOpenRouterModelGateway } from "../src/model-gateway";
import type { ModelRequest } from "../src/on-demand-dictionary";

if (!Bun.argv.includes("--run")) {
  console.error("Paid English evaluation is disabled. Re-run with --run to call OpenRouter.");
  process.exit(2);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required.");
  process.exit(2);
}

const corpus = await Bun.file(resolve(flag("--corpus") ?? "fixtures/english-evaluation-corpus.json")).json() as Corpus;
const outputDirectory = resolve(flag("--out-dir") ?? "data/english-evaluation");
await mkdir(outputDirectory, { recursive: true });
const gateway = createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY });
const judgments: EnglishReviewerJudgment[] = [];
for (const test of corpus.reviewer) {
  const candidateId = `review:${test.id}`;
  const seeded = seededReviewerFixture(test.defect);
  const response = await gateway.call(request({
    role: "entry-review",
    model: "google/gemini-3-flash-preview",
    promptVersion: "english-entry-review-v1",
    prompt: [
      "Reject only. Return JSON with candidateId and issues. Any material issue must be listed; never rewrite.",
      "Check omissions, invented senses, pronunciations, merged senses, circular definitions, unsupported labels, and misleading examples.",
      `candidateId: ${candidateId}`,
      `source_evidence: ${JSON.stringify(seeded.sourceEvidence)}`,
      `candidate: ${JSON.stringify(seeded.candidate)}`
    ].join("\n"),
    responseSchema: {
      name: "reject_only_review",
      schema: {
        type: "object", additionalProperties: false,
        properties: { candidateId: { type: "string" }, issues: { type: "array", items: { type: "string" } } },
        required: ["candidateId", "issues"]
      }
    }
  }));
  judgments.push({ id: test.id, expected: test.expected, actual: accepted(response.text, candidateId) ? "accept" : "reject" });
  await Bun.write(resolve(outputDirectory, "reviewer-results.json"), `${JSON.stringify({ judgments }, null, 2)}\n`);
}

const reviewerSummary = summarizeEnglishReviewerEvaluation(judgments);
await Bun.write(resolve(outputDirectory, "reviewer-results.json"), `${JSON.stringify({ judgments, summary: reviewerSummary }, null, 2)}\n`);
console.log(JSON.stringify({
  reviewerSummary
}, null, 2));
if (reviewerSummary.releaseBlocked) process.exitCode = 1;

function request(input: Pick<ModelRequest, "role" | "model" | "promptVersion" | "prompt" | "responseSchema">): ModelRequest {
  return {
    ...input,
    provider: "openrouter",
    reasoningEffort: "minimal",
    requestedServiceTier: "standard",
    signal: new AbortController().signal
  };
}

function accepted(text: string, candidateId: string): boolean {
  try {
    const value = JSON.parse(text) as { candidateId?: unknown; issues?: unknown };
    return value.candidateId === candidateId && Array.isArray(value.issues) && value.issues.length === 0;
  } catch {
    return false;
  }
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function seededReviewerFixture(defect: ReviewerDefect) {
  const sourceEvidence = {
    headword: "bank",
    pronunciations: [{ ipa: "/bæŋk/", region: "US", evidenceId: "source:bank:pron:1" }],
    senses: [
      { evidenceId: "source:bank:1", partOfSpeech: "noun", definition: "a financial institution", domains: ["finance"] },
      { evidenceId: "source:bank:2", partOfSpeech: "noun", definition: "land alongside a river", domains: ["geography"] }
    ]
  };
  const candidate: SeededCandidate = {
    headword: "bank",
    pronunciations: [{ ipa: "/bæŋk/", region: "US", evidenceIds: ["source:bank:pron:1"] }],
    senses: [
      { definition: "a financial institution", partOfSpeech: "noun", domains: ["finance"], regions: [], registers: [], dated: false, usage: [], evidenceIds: ["source:bank:1"], examples: ["She deposited money at the bank."] },
      { definition: "land alongside a river", partOfSpeech: "noun", domains: ["geography"], regions: [], registers: [], dated: false, usage: [], evidenceIds: ["source:bank:2"], examples: ["They picnicked on the river bank."] }
    ]
  };
  if (defect === "omission") candidate.senses.pop();
  if (defect === "invented-sense") candidate.senses.push({
    definition: "a kind of bird", partOfSpeech: "noun", domains: ["zoology"], regions: [], registers: [], dated: false,
    usage: [], evidenceIds: [], examples: ["A bank flew overhead."]
  });
  if (defect === "wrong-pronunciation") candidate.pronunciations[0].ipa = "/bɑːŋk/";
  if (defect === "merged-senses") candidate.senses = [{
    ...candidate.senses[0], definition: "a financial institution or land alongside a river",
    domains: ["finance", "geography"], evidenceIds: ["source:bank:1", "source:bank:2"]
  }];
  if (defect === "circular-definition") candidate.senses[0].definition = "a bank used for banking";
  if (defect === "unsupported-label") candidate.senses[0].regions = ["Mars"];
  if (defect === "misleading-example") candidate.senses[0].examples = ["They picnicked on the river bank."];
  return { sourceEvidence, candidate };
}

type SeededCandidate = {
  headword: string;
  pronunciations: Array<{ ipa: string; region: string; evidenceIds: string[] }>;
  senses: Array<{
    definition: string; partOfSpeech: string; domains: string[]; regions: string[]; registers: string[];
    dated: boolean; usage: string[]; evidenceIds: string[]; examples: string[];
  }>;
};
type ReviewerDefect = null | "omission" | "invented-sense" | "wrong-pronunciation" | "merged-senses"
  | "circular-definition" | "unsupported-label" | "misleading-example";
type Corpus = {
  reviewer: Array<{ id: string; expected: "accept" | "reject"; defect: ReviewerDefect }>;
};
