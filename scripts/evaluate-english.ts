import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeEnglishReviewerEvaluation, type EnglishReviewerJudgment } from "../src/english-evaluation";
import { createOpenRouterModelGateway } from "../src/model-gateway";
import {
  createEnglishOnDemandEvaluationContracts,
  type ModelRequest
} from "../src/on-demand-dictionary";
import type { EnglishSourceRecord } from "../src/english-types";

if (!Bun.argv.includes("--run")) {
  console.error("Paid English evaluation is disabled. Re-run with --run to call OpenRouter.");
  process.exit(2);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required.");
  process.exit(2);
}

const corpus = await Bun.file(resolve(flag("--corpus") ?? "fixtures/english-evaluation-corpus.json")).json() as Corpus;
const authorModels = flags("--author-model");
const reviewerModels = flags("--reviewer-model");
if (authorModels.length < 2 || reviewerModels.length < 2) {
  console.error("Pass at least two --author-model and two --reviewer-model values for a blind comparison.");
  process.exit(2);
}
const outputDirectory = resolve(flag("--out-dir") ?? "data/english-evaluation");
await mkdir(outputDirectory, { recursive: true });
const gateway = createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY });
const reviewerResults: Array<{ model: string; judgments: EnglishReviewerJudgment[]; summary: ReturnType<typeof summarizeEnglishReviewerEvaluation> }> = [];
for (const reviewerModel of reviewerModels) {
  const contracts = createEnglishOnDemandEvaluationContracts({ author: authorModels[0], reviewer: reviewerModel });
  const judgments: EnglishReviewerJudgment[] = [];
  for (const test of corpus.reviewer) {
    const candidateId = `review:${test.id}`;
    const seeded = seededReviewerFixture(test.defect);
    const response = await gateway.call(request({
      ...contracts.entryReview,
      prompt: contracts.entryReview.prompt(candidateId, {
        sourceEvidence: seeded.sourceEvidence,
        candidate: seeded.candidate
      })
    }));
    judgments.push({ id: test.id, expected: test.expected, actual: accepted(response.text) ? "accept" : "reject" });
  }
  reviewerResults.push({ model: reviewerModel, judgments, summary: summarizeEnglishReviewerEvaluation(judgments) });
}

const generationResults: Array<{
  caseId: string;
  authorModel: string;
  reviewerModel: string;
  accepted: boolean;
}> = [];
for (const [caseIndex, test] of corpus.generation.entries()) {
  for (const [authorIndex, authorModel] of authorModels.entries()) {
    const authorContracts = createEnglishOnDemandEvaluationContracts({ author: authorModel, reviewer: reviewerModels[0] });
    const authored = await gateway.call(request({
      ...authorContracts.entryAuthor,
      prompt: authorContracts.entryAuthor.prompt(`generation:${caseIndex}:${authorIndex}`, test.headword, test.sourceEvidence, test.context)
    }));
    for (const [reviewerIndex, reviewerModel] of reviewerModels.entries()) {
      const reviewContracts = createEnglishOnDemandEvaluationContracts({ author: authorModel, reviewer: reviewerModel });
      const candidateId = `blind:${caseIndex}:${authorIndex}:${reviewerIndex}`;
      const reviewed = await gateway.call(request({
        ...reviewContracts.entryReview,
        prompt: reviewContracts.entryReview.prompt(candidateId, {
          sourceEvidence: test.sourceEvidence,
          candidate: parsedCandidate(authored.text)
        })
      }));
      generationResults.push({
        caseId: test.id,
        authorModel,
        reviewerModel,
        accepted: accepted(reviewed.text)
      });
    }
  }
}

const output = { reviewerResults, generationResults };
await Bun.write(resolve(outputDirectory, "comparison-results.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (reviewerResults.some(({ summary }) => summary.releaseBlocked)) process.exitCode = 1;

function request(input: Pick<ModelRequest, "role" | "model" | "promptVersion" | "prompt" | "responseSchema">): ModelRequest {
  return {
    ...input,
    provider: "openrouter",
    reasoningEffort: "minimal",
    requestedServiceTier: "standard",
    signal: new AbortController().signal
  };
}

function accepted(text: string): boolean {
  return text.trim() === "ACCEPT";
}

function parsedCandidate(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function flags(name: string): string[] {
  return Bun.argv.flatMap((value, index) => value === name && Bun.argv[index + 1] ? [Bun.argv[index + 1]] : []);
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
  generation: Array<{ id: string; headword: string; context: string; sourceEvidence: EnglishSourceRecord[] }>;
};
