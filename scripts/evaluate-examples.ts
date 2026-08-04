import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  defaultModelCall,
  callWithTimeout,
  combineTranslations,
  filterCandidate,
  generatorConfig,
  generatorPrompt,
  parseGeneration,
  parseTranslation,
  parseReview,
  reviewerConfig,
  reviewerPrompt,
  reviewReasonCodes,
  translatorConfig,
  translatorPrompt,
  type Generated,
  type GenerationSeed,
  type ModelCall,
  type ModelRole
} from "../src/example-enrichment";

const repoRoot = resolve(import.meta.dir, "..");
const requiredSlices = ["easy", "polysemous", "kana-only", "should-abstain", "zh-tw-trap"] as const;

type Slice = (typeof requiredSlices)[number];
type ModelConfig = {
  model: string;
  reasoningEffort: string;
  provider: string;
  allowFallbacks: false;
  requireParameters: true;
};
type CorpusCase = {
  id: string;
  slice: Slice;
  expect: "candidate" | "abstain";
  seed: GenerationSeed;
};
type Candidate = Extract<Generated, { kind: "candidate" }>;
type FixtureCandidate = { sentence: string; translations: Record<string, string> };
type CalibrationCase = {
  id: string;
  expectedReason: (typeof reviewReasonCodes)[number];
  base: { seed: GenerationSeed; candidate: FixtureCandidate };
  mutation:
    | { kind: "replace-sentence"; sentence: string }
    | { kind: "replace-translation"; lang: string; text: string }
    | { kind: "replace-example"; candidate: FixtureCandidate };
};
type GenerationOutcome = {
  caseId: string;
  slice: Slice;
  repeat: number;
  passed: boolean;
  properties: string[];
  rawResponse: string | null;
  reviewerRawResponse: string | null;
  translatorRawResponse: string | null;
  error: string | null;
};
type CalibrationOutcome = {
  caseId: string;
  label: "accept" | (typeof reviewReasonCodes)[number];
  passed: boolean;
  classification: "correct" | "false_accept" | "false_reject" | "wrong_reason";
  actualDecision: string;
  rawResponse: string | null;
  error: string | null;
};

export type EvaluationInputs = {
  runId: string;
  repeats: number;
  timeoutMs: number;
  corpus: CorpusCase[];
  calibration: CalibrationCase[];
  generatorCandidates: ModelConfig[];
  translator: ModelConfig;
  reviewer: ModelConfig;
  sourceDigests: Record<string, string>;
  gitCommit: string;
};

export async function runEvaluation(inputs: EvaluationInputs, modelCall: ModelCall) {
  validateInputs(inputs);
  const startedAt = new Date().toISOString();
  const generation = [];

  for (const config of inputs.generatorCandidates) {
    const outcomes: GenerationOutcome[] = [];
    for (let repeat = 1; repeat <= inputs.repeats; repeat += 1) {
      for (const corpusCase of inputs.corpus) {
        outcomes.push(
          await scoreGenerationAttempt(
            corpusCase,
            repeat,
            config,
            inputs.translator,
            inputs.reviewer,
            inputs.timeoutMs,
            modelCall
          )
        );
      }
    }
    generation.push({
      config,
      attempted: outcomes.length,
      passed: outcomes.filter((outcome) => outcome.passed).length,
      failed: outcomes.filter((outcome) => !outcome.passed).length,
      bySlice: Object.fromEntries(
        requiredSlices.map((slice) => {
          const sliceOutcomes = outcomes.filter((outcome) => outcome.slice === slice);
          return [
            slice,
            {
              attempted: sliceOutcomes.length,
              passed: sliceOutcomes.filter((outcome) => outcome.passed).length,
              failed: sliceOutcomes.filter((outcome) => !outcome.passed).length
            }
          ];
        })
      ),
      outcomes
    });
  }

  const calibrationOutcomes = await scoreCalibration(
    inputs.calibration,
    inputs.reviewer,
    inputs.timeoutMs,
    modelCall
  );
  const negativeOutcomes = calibrationOutcomes.filter((outcome) => outcome.label !== "accept");
  const positiveOutcomes = calibrationOutcomes.filter((outcome) => outcome.label === "accept");
  const falseAcceptCount = negativeOutcomes.filter((outcome) => outcome.classification === "false_accept").length;
  const falseRejectCount = positiveOutcomes.filter((outcome) => outcome.classification === "false_reject").length;

  return {
    schemaVersion: 1,
    runId: inputs.runId,
    status: "completed" as const,
    startedAt,
    completedAt: new Date().toISOString(),
    gitCommit: inputs.gitCommit,
    sourceDigests: inputs.sourceDigests,
    repeats: inputs.repeats,
    timeoutMs: inputs.timeoutMs,
    generatorCandidates: inputs.generatorCandidates,
    reviewerConfig: inputs.reviewer,
    translatorConfig: inputs.translator,
    corpus: inputs.corpus,
    calibration: inputs.calibration,
    generation,
    reviewerCalibration: {
      config: inputs.reviewer,
      falseAccepts: rate(falseAcceptCount, negativeOutcomes.length),
      falseRejects: rate(falseRejectCount, positiveOutcomes.length),
      exactLabels: rate(
        calibrationOutcomes.filter((outcome) => outcome.passed).length,
        calibrationOutcomes.length
      ),
      outcomes: calibrationOutcomes
    }
  };
}

async function scoreGenerationAttempt(
  corpusCase: CorpusCase,
  repeat: number,
  generator: ModelConfig,
  translator: ModelConfig,
  reviewer: ModelConfig,
  timeoutMs: number,
  modelCall: ModelCall
): Promise<GenerationOutcome> {
  let rawResponse: string | null = null;
  let reviewerRawResponse: string | null = null;
  let translatorRawResponse: string | null = null;
  try {
    rawResponse = await invoke(modelCall, "generator", generator, generatorPrompt(corpusCase.seed, null), timeoutMs);
    const generated = parseGeneration(rawResponse);
    if (corpusCase.expect === "abstain") {
      return {
        caseId: corpusCase.id,
        slice: corpusCase.slice,
        repeat,
        passed: generated.kind === "abstain",
        properties: [generated.kind === "abstain" ? "abstained" : "failed_to_abstain"],
        rawResponse,
        reviewerRawResponse,
        translatorRawResponse,
        error: null
      };
    }
    if (generated.kind === "abstain") {
      return {
        caseId: corpusCase.id,
        slice: corpusCase.slice,
        repeat,
        passed: false,
        properties: [`unexpected_abstention:${generated.reason}`],
        rawResponse,
        reviewerRawResponse,
        translatorRawResponse,
        error: null
      };
    }

    translatorRawResponse = await invoke(
      modelCall,
      "translator",
      translator,
      translatorPrompt(corpusCase.seed, generated),
      timeoutMs
    );
    const candidate = combineTranslations(generated, parseTranslation(translatorRawResponse));
    const filterReasons = filterCandidate(corpusCase.seed, candidate);
    if (filterReasons.length > 0) {
      return {
        caseId: corpusCase.id,
        slice: corpusCase.slice,
        repeat,
        passed: false,
        properties: filterReasons.map((reason) => `deterministic_filter:${reason}`),
        rawResponse,
        reviewerRawResponse,
        translatorRawResponse,
        error: null
      };
    }

    const id = `eval:${configKey(generator)}:${corpusCase.id}:${repeat}`;
    reviewerRawResponse = await invoke(
      modelCall,
      "reviewer",
      reviewer,
      reviewerPrompt(id, corpusCase.seed, candidate),
      timeoutMs
    );
    const review = parseReview(reviewerRawResponse, id);
    return {
      caseId: corpusCase.id,
      slice: corpusCase.slice,
      repeat,
      passed: review.decision === "accept",
      properties: [review.decision === "accept" ? "reviewer_accepted" : `reviewer_rejected:${review.reason}`],
      rawResponse,
      reviewerRawResponse,
      translatorRawResponse,
      error: null
    };
  } catch (error) {
    return {
      caseId: corpusCase.id,
      slice: corpusCase.slice,
      repeat,
      passed: false,
      properties: ["model_or_parse_failure"],
      rawResponse,
      reviewerRawResponse,
      translatorRawResponse,
      error: errorMessage(error)
    };
  }
}

async function scoreCalibration(
  cases: CalibrationCase[],
  reviewer: ModelConfig,
  timeoutMs: number,
  modelCall: ModelCall
): Promise<CalibrationOutcome[]> {
  const outcomes: CalibrationOutcome[] = [];
  for (const calibrationCase of cases) {
    const base = toCandidate(calibrationCase.base.candidate);
    outcomes.push(
      await scoreReview(
        `${calibrationCase.id}:base`,
        "accept",
        calibrationCase.base.seed,
        base,
        reviewer,
        timeoutMs,
        modelCall
      )
    );
    outcomes.push(
      await scoreReview(
        `${calibrationCase.id}:mutation`,
        calibrationCase.expectedReason,
        calibrationCase.base.seed,
        applyMutation(base, calibrationCase.mutation),
        reviewer,
        timeoutMs,
        modelCall
      )
    );
  }
  return outcomes;
}

async function scoreReview(
  caseId: string,
  label: CalibrationOutcome["label"],
  seed: GenerationSeed,
  candidate: Candidate,
  reviewer: ModelConfig,
  timeoutMs: number,
  modelCall: ModelCall
): Promise<CalibrationOutcome> {
  let rawResponse: string | null = null;
  try {
    rawResponse = await invoke(modelCall, "reviewer", reviewer, reviewerPrompt(caseId, seed, candidate), timeoutMs);
    const decision = parseReview(rawResponse, caseId);
    if (label === "accept") {
      return decision.decision === "accept"
        ? { caseId, label, passed: true, classification: "correct", actualDecision: "accept", rawResponse, error: null }
        : {
            caseId,
            label,
            passed: false,
            classification: "false_reject",
            actualDecision: `reject:${decision.reason}`,
            rawResponse,
            error: null
          };
    }
    if (decision.decision === "accept") {
      return {
        caseId,
        label,
        passed: false,
        classification: "false_accept",
        actualDecision: "accept",
        rawResponse,
        error: null
      };
    }
    const exact = decision.reason === label;
    return {
      caseId,
      label,
      passed: exact,
      classification: exact ? "correct" : "wrong_reason",
      actualDecision: `reject:${decision.reason}`,
      rawResponse,
      error: null
    };
  } catch (error) {
    return {
      caseId,
      label,
      passed: false,
      classification: label === "accept" ? "false_reject" : "false_accept",
      actualDecision: "invalid_or_missing",
      rawResponse,
      error: errorMessage(error)
    };
  }
}

async function invoke(
  modelCall: ModelCall,
  role: ModelRole,
  config: ModelConfig,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  return callWithTimeout(
    modelCall,
    { role, ...config, prompt, signal: new AbortController().signal },
    timeoutMs
  );
}

function applyMutation(candidate: Candidate, mutation: CalibrationCase["mutation"]): Candidate {
  if (mutation.kind === "replace-example") return toCandidate(mutation.candidate);
  if (mutation.kind === "replace-sentence") return { ...candidate, sentence: mutation.sentence };
  return {
    ...candidate,
    translations: candidate.translations.map((translation) =>
      translation.lang === mutation.lang ? { ...translation, text: mutation.text } : translation
    )
  };
}

function toCandidate(candidate: FixtureCandidate): Candidate {
  return {
    kind: "candidate",
    sentence: candidate.sentence,
    translations: Object.entries(candidate.translations).map(([lang, text]) => ({ lang, text }))
  };
}

function rate(count: number, denominator: number) {
  return { count, denominator, rate: denominator === 0 ? null : count / denominator };
}

function validateInputs(inputs: EvaluationInputs): void {
  if (!Number.isInteger(inputs.repeats) || inputs.repeats < 2 || inputs.repeats > 10) {
    throw new Error("--repeats must be an integer from 2 to 10");
  }
  if (!Number.isInteger(inputs.timeoutMs) || inputs.timeoutMs < 1_000 || inputs.timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be an integer from 1000 to 120000");
  }
  const slices = new Set(inputs.corpus.map((item) => item.slice));
  for (const slice of requiredSlices) {
    if (!slices.has(slice)) throw new Error(`Corpus is missing the ${slice} slice`);
  }
  if (!inputs.corpus.some((item) => item.slice === "should-abstain" && item.expect === "abstain")) {
    throw new Error("The should-abstain slice must score abstention");
  }
  if (inputs.generatorCandidates.length < 2) throw new Error("At least two generator triples are required");
  const candidateKeys = inputs.generatorCandidates.map(configKey);
  if (new Set(candidateKeys).size !== candidateKeys.length) throw new Error("Generator triples must be unique");
  for (const config of [...inputs.generatorCandidates, inputs.translator, inputs.reviewer]) validateConfig(config);
  if (!inputs.generatorCandidates.some((config) => sameConfig(config, generatorConfig))) {
    throw new Error("Generator candidates must include the pinned production configuration");
  }
  if (!sameConfig(inputs.reviewer, reviewerConfig)) {
    throw new Error("Reviewer calibration must use the pinned production configuration");
  }
  if (!sameConfig(inputs.translator, translatorConfig)) {
    throw new Error("Translation must use the pinned production configuration");
  }
  const coveredReasons = new Set(inputs.calibration.map((item) => item.expectedReason));
  for (const reason of reviewReasonCodes) {
    if (!coveredReasons.has(reason)) throw new Error(`Calibration is missing reviewer reason ${reason}`);
  }
  for (const item of inputs.calibration) {
    const reasons = filterCandidate(item.base.seed, toCandidate(item.base.candidate));
    if (reasons.length > 0) throw new Error(`Calibration base ${item.id} fails the deterministic filter: ${reasons.join(",")}`);
    if (item.mutation.kind === "replace-translation" && !item.base.candidate.translations[item.mutation.lang]) {
      throw new Error(`Calibration mutation ${item.id} replaces a missing translation`);
    }
  }
}

function validateConfig(config: ModelConfig): void {
  if (!config.model || !config.provider || !config.reasoningEffort) throw new Error("Model triples cannot be blank");
  if (/(^|[-_.])latest($|[-_.])/i.test(config.model)) throw new Error(`Floating model alias is not allowed: ${config.model}`);
  if (config.allowFallbacks !== false || config.requireParameters !== true) {
    throw new Error(`Config ${configKey(config)} must disable fallbacks and require parameters`);
  }
}

function sameConfig(left: ModelConfig, right: ModelConfig): boolean {
  return configKey(left) === configKey(right);
}

function configKey(config: Pick<ModelConfig, "model" | "reasoningEffort" | "provider">): string {
  return `${config.provider}/${config.model}/${config.reasoningEffort}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadInputs(args: ReturnType<typeof parseArgs>): Promise<EvaluationInputs> {
  const [corpusText, calibrationText, configsText] = await Promise.all([
    Bun.file(args.corpusPath).text(),
    Bun.file(args.calibrationPath).text(),
    Bun.file(args.configsPath).text()
  ]);
  const corpusFixture = JSON.parse(corpusText) as { schemaVersion?: number; cases?: CorpusCase[] };
  const calibrationFixture = JSON.parse(calibrationText) as { schemaVersion?: number; cases?: CalibrationCase[] };
  const configsFixture = JSON.parse(configsText) as {
    schemaVersion?: number;
    generatorCandidates?: ModelConfig[];
    translator?: ModelConfig;
    reviewer?: ModelConfig;
  };
  if (corpusFixture.schemaVersion !== 1 || !Array.isArray(corpusFixture.cases)) throw new Error("Invalid corpus fixture");
  if (calibrationFixture.schemaVersion !== 1 || !Array.isArray(calibrationFixture.cases)) {
    throw new Error("Invalid calibration fixture");
  }
  if (
    configsFixture.schemaVersion !== 1 ||
    !Array.isArray(configsFixture.generatorCandidates) ||
    !configsFixture.translator ||
    !configsFixture.reviewer
  ) {
    throw new Error("Invalid model config fixture");
  }
  return {
    runId: args.runId,
    repeats: args.repeats,
    timeoutMs: args.timeoutMs,
    corpus: corpusFixture.cases,
    calibration: calibrationFixture.cases,
    generatorCandidates: configsFixture.generatorCandidates,
    translator: configsFixture.translator,
    reviewer: configsFixture.reviewer,
    sourceDigests: {
      [args.corpusPath]: digest(corpusText),
      [args.calibrationPath]: digest(calibrationText),
      [args.configsPath]: digest(configsText)
    },
    gitCommit: currentCommit()
  };
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function currentCommit(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Unable to record the current git commit");
  return new TextDecoder().decode(result.stdout).trim();
}

function assertLiveRuntime(inputs: EvaluationInputs): void {
  const unsupportedGenerator = inputs.generatorCandidates.find((config) => config.provider !== "google");
  if (unsupportedGenerator) throw new Error(`Live runner does not support generator provider ${unsupportedGenerator.provider}`);
  if (inputs.reviewer.provider !== "anthropic") {
    throw new Error(`Live runner does not support reviewer provider ${inputs.reviewer.provider}`);
  }
  if (inputs.translator.provider !== "google") {
    throw new Error(`Live runner does not support translator provider ${inputs.translator.provider}`);
  }
  const missing = [];
  if (!process.env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!process.env.GEMINI_ZH_TW_API_KEY) missing.push("GEMINI_ZH_TW_API_KEY");
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) throw new Error(`Live evaluation requires ${missing.join(" and ")}`);
}

function parseArgs(argv: string[]) {
  const runId = readFlag(argv, "--run-id");
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error("--run-id is required and must contain only letters, digits, dots, underscores, or hyphens");
  }
  return {
    runId,
    repeats: parseInteger(readFlag(argv, "--repeats") ?? "3", "--repeats"),
    timeoutMs: parseInteger(readFlag(argv, "--timeout-ms") ?? "30000", "--timeout-ms"),
    corpusPath: resolve(readFlag(argv, "--corpus") ?? join(repoRoot, "fixtures/example-evaluation-corpus.json")),
    calibrationPath: resolve(
      readFlag(argv, "--calibration") ?? join(repoRoot, "fixtures/example-review-calibration.json")
    ),
    configsPath: resolve(readFlag(argv, "--configs") ?? join(repoRoot, "fixtures/example-evaluation-configs.json")),
    outDirectory: resolve(readFlag(argv, "--out-dir") ?? join(repoRoot, "data/example-evaluation"))
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const runDirectory = join(args.outDirectory, args.runId);
  if (existsSync(runDirectory)) throw new Error(`Evaluation run already exists: ${runDirectory}`);
  const inputs = await loadInputs(args);
  validateInputs(inputs);
  assertLiveRuntime(inputs);
  const result = await runEvaluation(inputs, defaultModelCall);
  await mkdir(args.outDirectory, { recursive: true });
  await mkdir(runDirectory);
  const resultPath = join(runDirectory, "result.json");
  const file = await open(resultPath, "wx");
  try {
    await file.writeFile(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await file.close();
  }
  console.log(`Wrote immutable evaluation result to ${resultPath}`);
}

if (import.meta.main) await main();
