import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeEnglishReviewerEvaluation, type EnglishReviewerJudgment } from "../src/english-evaluation";
import { createOpenRouterModelGateway } from "../src/model-gateway";
import { englishOnDemandEvaluationContracts, type ModelRequest } from "../src/on-demand-dictionary";

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
const generatorModels = ["openai/gpt-5.6-luna", "google/gemini-3-flash-preview"] as const;
const judgeModel = "anthropic/claude-sonnet-4.6";
const blinded: BlindCandidate[] = [];
const answerKey: Record<string, string> = {};

for (const test of corpus.generation) {
  for (const model of generatorModels) {
    const candidateId = blindId(test.id, model);
    const response = await gateway.call(request({
      role: "entry-author",
      model,
      promptVersion: "english-generator-bakeoff-v1",
      prompt: [
        "Author a complete learner-grade English dictionary entry as JSON.",
        "Keep every established sense, pronunciation, part of speech, register, region, domain, dated status, usage distinction, and example structured.",
        `headword: ${test.headword}`,
        `hard_case_focus: ${test.focus}`
      ].join("\n")
    }));
    const judgment = await gateway.call(request({
      role: "entry-review",
      model: judgeModel,
      promptVersion: "english-generator-judge-v1",
      prompt: [
        "Score this anonymous English dictionary candidate. Do not infer or discuss which model wrote it.",
        "Return the candidateId, five integer scores from 0 to 4, and fatalIssues.",
        "Coverage includes every established sense. Structure covers clean sense boundaries and parts of speech.",
        "Pronunciation covers heteronyms. Labels covers register, region, domain, dated, and usage distinctions.",
        "Examples must be natural and demonstrate the intended sense.",
        `candidateId: ${candidateId}`,
        `headword: ${test.headword}`,
        `hard_case_focus: ${test.focus}`,
        `candidate: ${response.text}`
      ].join("\n"),
      responseSchema: generatorScoreSchema()
    }));
    blinded.push({
      caseId: test.id,
      candidateId,
      headword: test.headword,
      response: response.text,
      score: parseScore(judgment.text, candidateId)
    });
    answerKey[candidateId] = model;
  }
}

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
}

const reviewerSummary = summarizeEnglishReviewerEvaluation(judgments);
const generatorSummary = summarizeGenerators(blinded, answerKey);
const pinnedGenerator = englishOnDemandEvaluationContracts.entryAuthor.model;
const releaseBlocked = reviewerSummary.releaseBlocked || generatorSummary.selectedGenerator !== pinnedGenerator;
await Bun.write(resolve(outputDirectory, "blind-candidates.json"), `${JSON.stringify(blinded, null, 2)}\n`);
await Bun.write(resolve(outputDirectory, "answer-key.json"), `${JSON.stringify(answerKey, null, 2)}\n`);
await Bun.write(resolve(outputDirectory, "reviewer-results.json"), `${JSON.stringify({ judgments, summary: reviewerSummary }, null, 2)}\n`);
await Bun.write(resolve(outputDirectory, "generator-results.json"), `${JSON.stringify(generatorSummary, null, 2)}\n`);
console.log(JSON.stringify({
  blindCandidates: blinded.length,
  judgeModel,
  generatorSummary,
  reviewerSummary,
  pinnedGenerator,
  releaseBlocked
}, null, 2));
if (releaseBlocked) process.exitCode = 1;

function request(input: Pick<ModelRequest, "role" | "model" | "promptVersion" | "prompt" | "responseSchema">): ModelRequest {
  return {
    ...input,
    provider: "openrouter",
    reasoningEffort: "minimal",
    requestedServiceTier: "flex",
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

function blindId(caseId: string, model: string): string {
  return createHash("sha256").update(`${caseId}:${model}`).digest("hex").slice(0, 12);
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function generatorScoreSchema() {
  return {
    name: "english_generator_score",
    schema: {
    type: "object", additionalProperties: false,
    properties: {
      candidateId: { type: "string" },
      coverage: { type: "integer", minimum: 0, maximum: 4 },
      structure: { type: "integer", minimum: 0, maximum: 4 },
      pronunciation: { type: "integer", minimum: 0, maximum: 4 },
      labels: { type: "integer", minimum: 0, maximum: 4 },
      examples: { type: "integer", minimum: 0, maximum: 4 },
      fatalIssues: { type: "array", items: { type: "string" } }
    },
    required: ["candidateId", "coverage", "structure", "pronunciation", "labels", "examples", "fatalIssues"]
    }
  };
}

function parseScore(text: string, candidateId: string): GeneratorScore {
  const value = JSON.parse(text) as Record<string, unknown>;
  const dimensions = ["coverage", "structure", "pronunciation", "labels", "examples"] as const;
  if (value.candidateId !== candidateId || !Array.isArray(value.fatalIssues)) throw new Error(`Malformed score: ${candidateId}`);
  for (const dimension of dimensions) {
    if (!Number.isInteger(value[dimension]) || Number(value[dimension]) < 0 || Number(value[dimension]) > 4) {
      throw new Error(`Malformed ${dimension} score: ${candidateId}`);
    }
  }
  const fatalIssues = value.fatalIssues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0);
  const total = fatalIssues.length > 0 ? 0 : dimensions.reduce((sum, dimension) => sum + Number(value[dimension]), 0);
  return {
    coverage: Number(value.coverage), structure: Number(value.structure), pronunciation: Number(value.pronunciation),
    labels: Number(value.labels), examples: Number(value.examples), fatalIssues, total
  };
}

function summarizeGenerators(candidates: BlindCandidate[], answerKey: Record<string, string>) {
  const totals = new Map<string, number[]>();
  for (const candidate of candidates) {
    const model = answerKey[candidate.candidateId];
    const scores = totals.get(model) ?? [];
    scores.push(candidate.score.total);
    totals.set(model, scores);
  }
  const models = Array.from(totals, ([model, scores]) => ({
    model,
    cases: scores.length,
    averageScore: scores.reduce((sum, score) => sum + score, 0) / scores.length
  })).sort((left, right) => right.averageScore - left.averageScore || left.model.localeCompare(right.model));
  const selectedGenerator = models.length >= 2 && models[0].averageScore === models[1].averageScore ? null : models[0]?.model ?? null;
  return { judgeModel, models, selectedGenerator };
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

type GeneratorScore = {
  coverage: number; structure: number; pronunciation: number; labels: number; examples: number;
  fatalIssues: string[]; total: number;
};
type SeededCandidate = {
  headword: string;
  pronunciations: Array<{ ipa: string; region: string; evidenceIds: string[] }>;
  senses: Array<{
    definition: string; partOfSpeech: string; domains: string[]; regions: string[]; registers: string[];
    dated: boolean; usage: string[]; evidenceIds: string[]; examples: string[];
  }>;
};
type BlindCandidate = {
  caseId: string; candidateId: string; headword: string; response: string; score: GeneratorScore;
};
type ReviewerDefect = null | "omission" | "invented-sense" | "wrong-pronunciation" | "merged-senses"
  | "circular-definition" | "unsupported-label" | "misleading-example";
type Corpus = {
  generation: Array<{ id: string; headword: string; focus: string }>;
  reviewer: Array<{ id: string; expected: "accept" | "reject"; defect: ReviewerDefect }>;
};
