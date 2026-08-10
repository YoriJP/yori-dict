import { resolve } from "node:path";
import { createOpenRouterModelGateway } from "../src/model-gateway";
import {
  createJapaneseOnDemandDictionary,
  onDemandEvaluationContracts,
  type AttemptRecord,
  type EnrichmentRefusal,
  type EnrichmentRepository,
  type ModelRequest,
  type SourceEvidence
} from "../src/on-demand-dictionary";
import type { PublicExample, PublicLookupItem } from "../src/types";

if (!Bun.argv.includes("--run")) {
  console.error("Paid evaluation is disabled. Re-run with --run to call OpenRouter.");
  process.exit(2);
}
const corpusPath = flag("--corpus") ?? "fixtures/on-demand-regression-corpus.json";
const corpus = await Bun.file(resolve(corpusPath)).json() as Corpus;
const selectedCase = flag("--case");
const selectedReviewCase = flag("--review-case");
const repeatValue = flag("--repeat");
if (Bun.argv.includes("--case") && !selectedCase?.trim()) {
  console.error("--case requires a non-empty candidate");
  process.exit(2);
}
if (Bun.argv.includes("--review-case") && !selectedReviewCase?.trim()) {
  console.error("--review-case requires a non-empty id");
  process.exit(2);
}
if (selectedCase && selectedReviewCase) {
  console.error("--case and --review-case cannot be combined");
  process.exit(2);
}
const repetitions = Bun.argv.includes("--repeat") ? Number(repeatValue) : 1;
if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  console.error("--repeat requires a positive integer");
  process.exit(2);
}
if (repetitions > 1 && !selectedReviewCase) {
  console.error("--repeat requires --review-case");
  process.exit(2);
}
const eligibility = corpus.eligibility.filter((candidate) =>
  !selectedReviewCase && (!selectedCase || candidate.candidate === selectedCase)
);
if (selectedCase && eligibility.length !== 1) {
  console.error(`Eval case not found: ${selectedCase}`);
  process.exit(2);
}
const acceptedExamples = selectedCase ? [] : corpus.acceptedExamples.filter((test) =>
  !selectedReviewCase || test.id === selectedReviewCase
);
const rejectedExamples = selectedCase ? [] : corpus.rejectedExamples.filter((test) =>
  !selectedReviewCase || test.id === selectedReviewCase
);
if (selectedReviewCase && acceptedExamples.length + rejectedExamples.length !== 1) {
  console.error(`Review eval case not found: ${selectedReviewCase}`);
  process.exit(2);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required.");
  process.exit(2);
}
const gateway = createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY });
let failed = 0;
let falseAccepts = 0;
let falseRejects = 0;

for (const test of eligibility) {
  const response = await gateway.call(request({
    role: "eligibility",
    model: onDemandEvaluationContracts.eligibility.model,
    promptVersion: onDemandEvaluationContracts.eligibility.promptVersion,
    prompt: onDemandEvaluationContracts.eligibility.prompt(test.candidate)
  }));
  const passed = response.text.trim() === test.expected;
  if (!passed) failed += 1;
  console.log(`${passed ? "PASS" : "FAIL"} eligibility/${test.candidate}: ${response.text.trim()}`);

  const production = await evaluateProductionPath(test, gateway);
  if (!production.passed) failed += 1;
  console.log(`${production.passed ? "PASS" : "FAIL"} production/${test.candidate}`);
  if (!production.passed) console.log(JSON.stringify(production.diagnostics));
}

for (const test of selectedCase || selectedReviewCase ? [] : corpus.reviewDefects) {
  const candidateId = `eval:${test.id}`;
  const response = await gateway.call(request({
    role: "entry-review",
    model: onDemandEvaluationContracts.entryReview.model,
    promptVersion: onDemandEvaluationContracts.entryReview.promptVersion,
    prompt: onDemandEvaluationContracts.entryReview.prompt(candidateId, test.candidate)
  }));
  const verdict = parseReview(response.text);
  const passed = verdict === "rejected";
  if (!passed) {
    failed += 1;
    falseAccepts += 1;
  }
  console.log(`${passed ? "PASS" : "FAIL"} review/${test.id}: ${verdict}`);
}

for (const { test, repetition } of repeated(acceptedExamples, repetitions)) {
  const candidateId = `eval:${test.id}`;
  const response = await gateway.call(request({
    role: "example-review",
    model: onDemandEvaluationContracts.exampleReview.model,
    promptVersion: onDemandEvaluationContracts.exampleReview.promptVersion,
    prompt: onDemandEvaluationContracts.exampleReview.prompt(candidateId, test.candidate)
  }));
  const verdict = parseReview(response.text);
  const passed = verdict === "accepted";
  if (!passed) {
    failed += 1;
    falseRejects += 1;
  }
  console.log(`${passed ? "PASS" : "FAIL"} review/${test.id}${repeatLabel(repetition, repetitions)}: ${verdict}`);
}

for (const { test, repetition } of repeated(rejectedExamples, repetitions)) {
  const candidateId = `eval:${test.id}`;
  const response = await gateway.call(request({
    role: "example-review",
    model: onDemandEvaluationContracts.exampleReview.model,
    promptVersion: onDemandEvaluationContracts.exampleReview.promptVersion,
    prompt: onDemandEvaluationContracts.exampleReview.prompt(candidateId, test.candidate)
  }));
  const verdict = parseReview(response.text);
  const passed = verdict === "rejected";
  if (!passed) {
    failed += 1;
    falseAccepts += 1;
  }
  console.log(`${passed ? "PASS" : "FAIL"} review/${test.id}${repeatLabel(repetition, repetitions)}: ${verdict}`);
}

const total = eligibility.length * 2
  + (selectedCase || selectedReviewCase ? 0 : corpus.reviewDefects.length)
  + acceptedExamples.length * repetitions
  + rejectedExamples.length * repetitions;
console.log(`${total - failed}/${total} passed`);
console.log(`review calibration: ${falseAccepts} false accept(s), ${falseRejects} false reject(s)`);
if (failed > 0) process.exitCode = 1;

function request(input: Omit<ModelRequest, "provider" | "reasoningEffort" | "requestedServiceTier" | "signal">): ModelRequest {
  return {
    ...input,
    provider: "openrouter",
    reasoningEffort: "minimal",
    requestedServiceTier: "flex",
    signal: new AbortController().signal
  };
}

function parseReview(text: string): "accepted" | "rejected" | "malformed" {
  const verdict = text.trim();
  if (verdict === "ACCEPT") return "accepted";
  if (verdict === "REJECT") return "rejected";
  return "malformed";
}

async function evaluateProductionPath(
  test: EligibilityCase,
  gateway: ReturnType<typeof createOpenRouterModelGateway>
): Promise<{ passed: boolean; diagnostics: Record<string, unknown> }> {
  const source: SourceEvidence = {
    source: "paid-regression-fixture",
    sourceEntryId: test.candidate,
    headword: test.expected,
    reading: test.reading,
    senses: test.sourceSenses.map((sense, index) => ({
      evidenceId: `paid-regression-fixture:${test.candidate}:${index + 1}`,
      partOfSpeech: sense.partOfSpeech,
      glosses: [{ lang: "en", text: sense.gloss }]
    }))
  };
  const repository = new EvaluationRepository(source);
  const refusals: EnrichmentRefusal[] = [];
  const dictionary = createJapaneseOnDemandDictionary({
    repository,
    modelGateway: gateway,
    reviewPasses: 2,
    timeoutMs: 60_000,
    logger: (event) => { if (event.event === "enrichment_refused") refusals.push(event); }
  });
  const entry = await dictionary.resolve({ query: test.candidate, targetDictionary: "ja", lang: "en" });
  const passed = Boolean(
    entry
    && entry.word === test.expected
    && entry.senses.length >= test.sourceSenses.length
    && entry.senses.every((sense) => (sense.examples?.length ?? 0) > 0)
    && repository.attempts.some((attempt) => attempt.role === "entry-author" && attempt.outcome === "candidate")
    && repository.attempts.some((attempt) => attempt.role === "entry-review" && attempt.outcome === "accepted")
    && repository.attempts.some((attempt) => attempt.role === "example-review" && attempt.outcome === "accepted")
  );
  return {
    passed,
    diagnostics: {
      attempts: repository.attempts.map(({ role, outcome, promptVersion }) => ({ role, outcome, promptVersion })),
      refusals: refusals.map(({ stage, headword, reason }) => ({ stage, headword, reason })),
      inputTokens: repository.attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
      outputTokens: repository.attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0),
      costUsd: repository.attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0)
    }
  };
}

class EvaluationRepository implements EnrichmentRepository {
  readonly attempts: AttemptRecord[] = [];
  private entry: PublicLookupItem | null = null;

  constructor(private readonly source: SourceEvidence) {}

  find(query: string) { return this.entry?.word === query ? this.entry : null; }
  findSources(query: string) { return query === this.source.headword ? [this.source] : []; }
  saveEntry(entry: PublicLookupItem) { this.entry = entry; }
  saveExample(senseId: string, example: PublicExample) {
    if (!this.entry) return;
    this.entry = {
      ...this.entry,
      senses: this.entry.senses.map((sense) => sense.id === senseId ? { ...sense, examples: [example] } : sense)
    };
  }
  recordAttempt(attempt: AttemptRecord) { this.attempts.push(attempt); }
  labelVocabulary() {
    return {
      partOfSpeech: new Set(["n", "adj-na", "adj-i", "adv", "int", "v1", "v5m"]),
      misc: new Set(["col"]),
      field: new Set(["comp"]),
      dialect: new Set(["ksb"])
    };
  }
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}

function repeated<T>(items: T[], repetitions: number): Array<{ test: T; repetition: number }> {
  return Array.from({ length: repetitions }, (_, repetition) =>
    items.map((test) => ({ test, repetition: repetition + 1 }))
  ).flat();
}

function repeatLabel(repetition: number, repetitions: number): string {
  return repetitions === 1 ? "" : `#${repetition}`;
}

type Corpus = {
  eligibility: EligibilityCase[];
  reviewDefects: Array<{ id: string; candidate: unknown }>;
  acceptedExamples: Array<{ id: string; candidate: unknown }>;
  rejectedExamples: Array<{ id: string; candidate: unknown }>;
};

type EligibilityCase = {
  candidate: string;
  expected: string;
  reading: string;
  sourceSenses: Array<{ partOfSpeech: string[]; gloss: string }>;
};
