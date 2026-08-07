import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Converter } from "opencc-js";
import { findPrcTerms } from "../scripts/taiwan-terminology";
import { deinflect } from "./deinflect";
import type { PublicExample, PublicLookupItem, PublicSense } from "./types";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "./english-types";

export type TargetDictionary = "ja" | "en";

const traceContext = new AsyncLocalStorage<string | undefined>();
const modelRunContext = new AsyncLocalStorage<ModelRunMetrics>();

export type ResolveRequest = {
  query: string;
  targetDictionary: TargetDictionary;
  traceId?: string;
  mode?: "on-demand" | "bulk";
  context?: {
    sentence?: string;
    lemma?: string;
    reading?: string;
  };
};

export type SourceEvidence = {
  source: string;
  sourceEntryId: string;
  headword: string;
  reading?: string;
  senses: Array<{
    evidenceId: string;
    partOfSpeech: string[];
    glosses: Array<{ lang: string; text: string }>;
    labels?: string[];
    pronunciation?: string;
  }>;
};

export type ModelRole = "eligibility" | "entry-author" | "entry-review" | "example-author" | "example-review";
export type ServiceTier = "flex" | "standard";

export type ModelRequest = {
  role: ModelRole;
  prompt: string;
  promptVersion: string;
  model: string;
  reasoningEffort: "minimal";
  provider: "openrouter";
  requestedServiceTier: ServiceTier;
  responseSchema?: { name: string; schema: Record<string, unknown> };
  signal: AbortSignal;
};

export type ModelResponse = {
  text: string;
  requestId: string;
  model: string;
  provider: string;
  effectiveServiceTier: ServiceTier;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
};

export type ModelGateway = {
  call(input: ModelRequest): Promise<ModelResponse>;
};

export type ModelGatewayErrorKind =
  | "transient"
  | "authentication"
  | "configuration"
  | "unsupported-parameter"
  | "permanent";

export class ModelGatewayError extends Error {
  constructor(readonly kind: ModelGatewayErrorKind, message: string) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export type AttemptRecord = {
  traceId?: string;
  candidateId?: string;
  role: ModelRole;
  promptVersion: string;
  model: string;
  reasoningEffort: "minimal";
  provider: string;
  requestedServiceTier: ServiceTier;
  effectiveServiceTier?: ServiceTier;
  requestId?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  prompt?: string;
  response?: string;
  error?: string;
  outcome: string;
};

export type EnrichmentRepository = {
  find(query: string, targetDictionary: TargetDictionary): PublicLookupItem | null;
  findSources(query: string, targetDictionary: TargetDictionary): SourceEvidence[];
  saveEntry(entry: PublicLookupItem): void;
  saveExample(senseId: string, example: PublicExample): void;
  recordAttempt(attempt: AttemptRecord): void;
  terminalOutcome(key: string): string | null;
  saveTerminalOutcome(key: string, outcome: string): void;
  knownLabels(): Set<string>;
};

export type OnDemandDictionary = {
  resolve(request: ResolveRequest): Promise<PublicLookupItem | null>;
};

export type DictionaryResolver<TEntry> = {
  resolve(request: ResolveRequest): Promise<TEntry | null>;
};

export type EnglishEnrichmentRepository = {
  find(query: string): EnglishEntry | null;
  findSources(query: string): EnglishSourceRecord[];
  saveEntry(entry: EnglishEntry): void;
  saveExample(senseId: string, example: EnglishExample): void;
  recordAttempt(attempt: AttemptRecord): void;
  terminalOutcome(key: string): string | null;
  saveTerminalOutcome(key: string, outcome: string): void;
};

export type EnglishOnDemandDictionary = DictionaryResolver<EnglishEntry>;

export type ModelCallLimiter = <T>(work: () => Promise<T>) => Promise<T>;

export type ModelRunSummary = {
  event: "model_run_summary";
  traceId: string;
  dictionary: TargetDictionary;
  attempts: number;
  outcomes: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type EnglishModelSelection = {
  author: string;
  reviewer: string;
};

type ModelRunMetrics = Omit<ModelRunSummary, "event" | "traceId" | "dictionary">;

export function createOnDemandDictionary(options: {
  repository: EnrichmentRepository;
  modelGateway: ModelGateway;
  concurrency?: number;
  timeoutMs?: number;
  limiter?: ModelCallLimiter;
  logger?: (summary: ModelRunSummary) => void;
}): OnDemandDictionary {
  const concurrency = positiveInteger(options.concurrency ?? 4, "Enrichment concurrency");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "Model timeout");
  const runLimited = options.limiter ?? createModelCallLimiter(concurrency);
  const entryInFlight = new Map<string, Promise<PublicLookupItem | null>>();
  const canonicalLocks = new Map<string, Promise<void>>();
  const exampleLocks = new Map<string, Promise<void>>();
  const runtime: RuntimeOptions = {
    repository: options.repository,
    modelGateway: {
      call(input) {
        return runLimited(() => callWithTimeout(options.modelGateway, input, timeoutMs));
      }
    },
    canonicalLocks,
    exampleLocks
  };

  return {
    async resolve(request) {
      const traceId = request.traceId ?? crypto.randomUUID();
      return traceContext.run(traceId, () => runWithModelSummary("ja", traceId, options.logger, async () => {
      const existing = options.repository.find(request.query, request.targetDictionary);
      if (existing && existing.senses.every((sense) => (sense.examples?.length ?? 0) > 0)) return existing;

      const key = `${effectiveMode(request.mode)}:${requestOutcomeKey(request)}`;
      const running = entryInFlight.get(key);
      if (running) return running;
      const task = (existing ? completeEntryExamples(runtime, existing, request.mode) : resolveMissing(request, runtime))
        .finally(() => entryInFlight.delete(key));
      entryInFlight.set(key, task);
      return task;
      }));
    }
  };
}

const stringArraySchema = { type: "array", items: { type: "string" } };
const entrySchema = {
  name: "japanese_dictionary_entry",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      headword: { type: "string" },
      reading: { type: "string" },
      senses: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            partOfSpeech: stringArraySchema,
            registers: stringArraySchema,
            domains: stringArraySchema,
            dialect: stringArraySchema,
            pronunciations: stringArraySchema,
            pragmaticFunctions: stringArraySchema,
            glosses: {
              type: "object",
              additionalProperties: false,
              properties: { en: stringArraySchema, "zh-tw": stringArraySchema },
              required: ["en", "zh-tw"]
            },
            evidenceIds: stringArraySchema,
            provenance: { type: "string", enum: ["source", "generated"] }
          },
          required: [
            "partOfSpeech", "registers", "domains", "dialect", "pronunciations",
            "pragmaticFunctions", "glosses", "evidenceIds", "provenance"
          ]
        }
      }
    },
    required: ["headword", "reading", "senses"]
  }
};
const exampleSchema = {
  name: "dictionary_example",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sentence: { type: "string" },
      translations: {
        type: "object",
        additionalProperties: false,
        properties: { en: { type: "string" }, "zh-tw": { type: "string" } },
        required: ["en", "zh-tw"]
      }
    },
    required: ["sentence", "translations"]
  }
};

const lunaModel = "openai/gpt-5.6-luna";
const geminiReviewModel = "google/gemini-3-flash-preview";
const entryAuthorConfig = modelConfig("entry-author", lunaModel, "entry-author-v1", entrySchema);
const entryReviewConfig = modelConfig("entry-review", geminiReviewModel, "entry-review-v2");
const exampleAuthorConfig = modelConfig("example-author", lunaModel, "example-author-v1", exampleSchema);
const exampleReviewConfig = modelConfig("example-review", geminiReviewModel, "example-review-v2");

type ModelConfig = Omit<ModelRequest, "prompt" | "signal">;

function modelConfig(
  role: ModelRole,
  model: string,
  promptVersion: string,
  responseSchema?: ModelRequest["responseSchema"]
): ModelConfig {
  return {
    role,
    model,
    provider: "openrouter",
    promptVersion,
    requestedServiceTier: "flex",
    reasoningEffort: "minimal",
    ...(responseSchema ? { responseSchema } : {})
  };
}

async function resolveMissing(
  request: ResolveRequest,
  options: RuntimeOptions
): Promise<PublicLookupItem | null> {
  if (request.targetDictionary !== "ja" || invalidRequest(request)) return null;
  const requestKey = requestOutcomeKey(request);
  if (options.repository.terminalOutcome(requestKey)) return null;

  let headword = request.context?.lemma?.trim() || request.query.trim();
  if (headword !== request.query.trim()) {
    const existing = options.repository.find(headword, request.targetDictionary);
    if (existing) return completeEntryExamples(options, existing, request.mode);
  }
  let evidence = options.repository.findSources(headword, request.targetDictionary);
  if (evidence.length > 0) {
    const sourceHeadwords = new Set(evidence.map((source) => source.headword));
    let sourceHeadword: string;
    if (sourceHeadwords.size === 1) {
      sourceHeadword = sourceHeadwords.values().next().value as string;
    } else {
      const eligibility = await eligibilityDecision(request, options);
      if (eligibility.kind === "provider-error") return null;
      if (eligibility.kind === "terminal") {
        options.repository.saveTerminalOutcome(requestKey, eligibility.outcome);
        return null;
      }
      if (!sourceHeadwords.has(eligibility.headword)) {
        options.repository.saveTerminalOutcome(requestKey, "unrelated-headword");
        return null;
      }
      sourceHeadword = eligibility.headword;
    }
    if (sourceHeadword !== headword) {
      headword = sourceHeadword;
      const existing = options.repository.find(headword, request.targetDictionary);
      if (existing) return completeEntryExamples(options, existing, request.mode);
      evidence = options.repository.findSources(headword, request.targetDictionary);
    }
    evidence = evidence.filter((source) => source.headword === headword);
  }
  if (evidence.length === 0) {
    const eligibility = await eligibilityDecision(request, options);
    if (eligibility.kind === "provider-error") return null;
    if (eligibility.kind === "terminal") {
      options.repository.saveTerminalOutcome(requestKey, eligibility.outcome);
      return null;
    }
    if (!relatedHeadword(request, eligibility.headword)) {
      options.repository.saveTerminalOutcome(requestKey, "unrelated-headword");
      return null;
    }
    const canonicalHeadword = eligibility.headword;
    if (canonicalHeadword !== headword) {
      headword = canonicalHeadword;
      const existing = options.repository.find(headword, request.targetDictionary);
      if (existing) return completeEntryExamples(options, existing, request.mode);
      evidence = options.repository.findSources(headword, request.targetDictionary);
    }
  }

  const canonicalKey = entryOutcomeKey(request.targetDictionary, headword);
  if (options.repository.terminalOutcome(canonicalKey)) return null;
  return serializeByKey(options.canonicalLocks, canonicalKey, async () => {
    if (options.repository.terminalOutcome(canonicalKey)) return null;
    const existing = options.repository.find(headword, request.targetDictionary);
    if (existing) return completeEntryExamples(options, existing, request.mode);
    return authorEntry(request, options, headword, evidence, requestKey, canonicalKey);
  });
}

async function authorEntry(
  request: ResolveRequest,
  options: RuntimeOptions,
  headword: string,
  evidence: SourceEvidence[],
  requestKey: string,
  canonicalKey: string
): Promise<PublicLookupItem | null> {
  const entryId = stableId("entry", headword);
  const authored = await callAndRecord(
    options,
    entryAuthorConfig,
    entryAuthorPrompt(entryId, headword, request, evidence),
    request.mode,
    entryId
  );
  if (!authored) return null;

  let entry: PublicLookupItem;
  try {
    entry = parseAuthoredEntry(authored.text, entryId, headword, evidence, options.repository.knownLabels());
  } catch {
    recordOutcome(options.repository, authored.attempt, "malformed");
    saveTerminal(options.repository, [requestKey, canonicalKey], "malformed-entry");
    return null;
  }
  recordOutcome(options.repository, authored.attempt, "candidate");

  const reviewed = await callAndRecord(
    options,
    entryReviewConfig,
    reviewPrompt(entryId, { entry, sourceEvidence: evidence }),
    request.mode,
    entryId
  );
  if (!reviewed) return null;
  const review = reviewOutcome(reviewed.text);
  recordOutcome(options.repository, reviewed.attempt, review);
  if (review !== "accepted") {
    saveTerminal(options.repository, [requestKey, canonicalKey], review);
    return null;
  }

  options.repository.saveEntry(entry);
  return completeEntryExamples(options, entry, request.mode);
}

async function eligibilityDecision(
  request: ResolveRequest,
  options: RuntimeOptions
): Promise<
  | { kind: "candidate"; headword: string }
  | { kind: "terminal"; outcome: "skipped" | "malformed-eligibility" }
  | { kind: "provider-error" }
> {
  const config = modelConfig("eligibility", lunaModel, "eligibility-v1");
  const result = await callAndRecord(
    options,
    config,
    eligibilityPrompt(request),
    request.mode,
    requestOutcomeKey(request)
  );
  if (!result) return { kind: "provider-error" };
  const line = result.text.trim();
  if (line === "SKIP") {
    recordOutcome(options.repository, result.attempt, "skipped");
    return { kind: "terminal", outcome: "skipped" };
  }
  if (!line || line.includes("\n") || Array.from(line).length > 80 || invalidText(line)) {
    recordOutcome(options.repository, result.attempt, "malformed");
    return { kind: "terminal", outcome: "malformed-eligibility" };
  }
  recordOutcome(options.repository, result.attempt, "candidate");
  return { kind: "candidate", headword: line };
}

async function completeEntryExamples(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  mode: ResolveRequest["mode"]
): Promise<PublicLookupItem> {
  const examples = await Promise.all(entry.senses.map((sense) => {
    if ((sense.examples?.length ?? 0) > 0) return Promise.resolve(null);
    return completeExample(options, entry, sense, mode);
  }));
  return {
    ...entry,
    senses: entry.senses.map((sense, index) => examples[index] ? { ...sense, examples: [examples[index]!] } : sense)
  };
}

async function completeExample(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  sense: PublicSense,
  mode: ResolveRequest["mode"]
): Promise<PublicExample | null> {
  const terminalKey = `example:${sense.id}`;
  if (options.repository.terminalOutcome(terminalKey)) return null;
  return serializeByKey(options.exampleLocks, terminalKey, async () => {
    if (options.repository.terminalOutcome(terminalKey)) return null;
    const staged = options.repository.find(entry.word, "ja")
      ?.senses.find((candidate) => candidate.id === sense.id)
      ?.examples?.[0];
    if (staged) return staged;
    return completeExampleWork(options, entry, sense, terminalKey, mode);
  });
}

async function completeExampleWork(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  sense: PublicSense,
  terminalKey: string,
  mode: ResolveRequest["mode"]
): Promise<PublicExample | null> {
  const candidateId = `${sense.id}:example`;
  const authored = await callAndRecord(options, exampleAuthorConfig, exampleAuthorPrompt(candidateId, entry, sense), mode, candidateId);
  if (!authored) return null;
  let example: PublicExample;
  try {
    example = parseExample(authored.text, entry.word);
  } catch {
    recordOutcome(options.repository, authored.attempt, "malformed");
    options.repository.saveTerminalOutcome(terminalKey, "malformed-example");
    return null;
  }
  recordOutcome(options.repository, authored.attempt, "candidate");
  const reviewed = await callAndRecord(
    options,
    exampleReviewConfig,
    reviewPrompt(candidateId, { entry: { word: entry.word, reading: entry.reading }, sense, example }),
    mode,
    candidateId
  );
  if (!reviewed) return null;
  const review = reviewOutcome(reviewed.text);
  recordOutcome(options.repository, reviewed.attempt, review);
  if (review !== "accepted") {
    options.repository.saveTerminalOutcome(terminalKey, review);
    return null;
  }
  options.repository.saveExample(sense.id, example);
  return example;
}

async function callAndRecord(
  options: ModelCallRuntime,
  config: ModelConfig,
  prompt: string,
  mode: ResolveRequest["mode"],
  candidateId: string
): Promise<{ text: string; attempt: AttemptRecord } | null> {
  const tiers: ServiceTier[] = config.requestedServiceTier === "flex"
    ? mode === "bulk" ? ["flex", "flex", "flex"] : ["flex", "standard"]
    : ["standard"];
  for (const requestedServiceTier of tiers) {
    const started = performance.now();
    try {
      const response = await options.modelGateway.call({
        ...config,
        requestedServiceTier,
        prompt,
        signal: new AbortController().signal
      });
      const attempt: AttemptRecord = {
        ...config,
        traceId: traceContext.getStore(),
        candidateId,
        model: response.model,
        provider: response.provider,
        requestedServiceTier,
        effectiveServiceTier: response.effectiveServiceTier,
        requestId: response.requestId,
        durationMs: Math.max(0, performance.now() - started),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        prompt: boundedLog(prompt),
        response: boundedLog(response.text),
        outcome: "pending"
      };
      return { text: response.text, attempt };
    } catch (error) {
      const kind = error instanceof ModelGatewayError ? error.kind : "permanent";
      persistAttempt(options.repository, {
        ...config,
        traceId: traceContext.getStore(),
        candidateId,
        requestedServiceTier,
        durationMs: Math.max(0, performance.now() - started),
        prompt: boundedLog(prompt),
        error: boundedLog(error instanceof Error ? error.message : "Unknown model gateway error"),
        outcome: kind
      });
      if (kind !== "transient" || requestedServiceTier !== "flex") return null;
    }
  }
  return null;
}

type ModelCallRuntime = {
  repository: { recordAttempt(attempt: AttemptRecord): void };
  modelGateway: ModelGateway;
};

type RuntimeOptions = {
  repository: EnrichmentRepository;
  modelGateway: ModelGateway;
  canonicalLocks: Map<string, Promise<void>>;
  exampleLocks: Map<string, Promise<void>>;
};

function entryOutcomeKey(targetDictionary: TargetDictionary, headword: string): string {
  return `entry:${targetDictionary}:${headword.trim()}`;
}

function requestOutcomeKey(request: ResolveRequest): string {
  const identity = JSON.stringify({
    query: request.query.trim(),
    lemma: request.context?.lemma?.trim() ?? "",
    reading: request.context?.reading?.trim() ?? "",
    sentence: request.context?.sentence?.trim() ?? ""
  });
  return `request:${request.targetDictionary}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function effectiveMode(mode: ResolveRequest["mode"]): "on-demand" | "bulk" {
  return mode === "bulk" ? "bulk" : "on-demand";
}

function saveTerminal(repository: EnrichmentRepository, keys: string[], outcome: string): void {
  for (const key of new Set(keys)) repository.saveTerminalOutcome(key, outcome);
}

function parseAuthoredEntry(
  text: string,
  entryId: string,
  expectedHeadword: string,
  evidence: SourceEvidence[],
  knownLabels: Set<string>
): PublicLookupItem {
  const value = parseObject(text);
  assertExactKeys(value, ["headword", "reading", "senses"]);
  if (
    value.headword !== expectedHeadword
    || typeof value.reading !== "string"
    || !isJapaneseLexicalText(value.headword)
    || !/^[\p{Script=Hiragana}\p{Script=Katakana}・ー]+$/u.test(value.reading)
  ) {
    throw new Error("Invalid generated headword");
  }
  if (!Array.isArray(value.senses) || value.senses.length === 0) throw new Error("Entry has no senses");

  const knownEvidence = new Map(
    evidence.flatMap((source) => source.senses.map((sense) => [sense.evidenceId, sense] as const))
  );
  const usedEvidence = new Set<string>();
  const senseKeys = new Set<string>();
  const senses: PublicSense[] = value.senses.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Invalid sense");
    const sense = candidate as Record<string, unknown>;
    assertExactKeys(sense, [
      "partOfSpeech", "registers", "domains", "dialect", "pronunciations",
      "pragmaticFunctions", "glosses", "evidenceIds", "provenance"
    ]);
    const partOfSpeech = requiredStringList(sense.partOfSpeech);
    if (partOfSpeech.length === 0 || partOfSpeech.some((label) => !knownLabels.has(label))) throw new Error("Invalid part of speech");
    if (sense.provenance !== "source" && sense.provenance !== "generated") throw new Error("Invalid provenance");
    const evidenceIds = requiredStringList(sense.evidenceIds);
    if (sense.provenance === "source" && evidenceIds.length === 0) throw new Error("Source sense has no evidence");
    if (sense.provenance === "generated" && evidenceIds.length > 0) throw new Error("Generated sense claims source evidence");
    for (const evidenceId of evidenceIds) {
      if (!knownEvidence.has(evidenceId)) throw new Error("Unknown source evidence");
      usedEvidence.add(evidenceId);
    }
    const glosses = parseGlosses(sense.glosses);
    const misc = requiredStringList(sense.registers);
    const field = requiredStringList(sense.domains);
    const dialect = requiredStringList(sense.dialect);
    if ([...misc, ...field, ...dialect].some((label) => !knownLabels.has(label))) throw new Error("Unsupported label");
    const pronunciations = requiredStringList(sense.pronunciations);
    if (pronunciations.some((reading) => !/^[\p{Script=Hiragana}\p{Script=Katakana}・ー]+$/u.test(reading))) {
      throw new Error("Invalid pronunciation");
    }
    const pragmaticFunctions = requiredStringList(sense.pragmaticFunctions);
    const authoredLabels = new Set([...misc, ...field, ...dialect]);
    const sourceLabels = new Set(evidenceIds.flatMap((evidenceId) => knownEvidence.get(evidenceId)?.labels ?? []));
    if (evidenceIds.length > 0 && !sameStringSet(authoredLabels, sourceLabels)) throw new Error("Source labels were changed");
    for (const evidenceId of evidenceIds) {
      const sourceSense = knownEvidence.get(evidenceId)!;
      if (sourceSense.partOfSpeech.some((label) => !partOfSpeech.includes(label))) {
        throw new Error("Source part of speech was changed");
      }
      if (sourceSense.labels?.some((label) => !authoredLabels.has(label))) {
        throw new Error("Source label was omitted");
      }
      if (
        sourceSense.pronunciation
        && sourceSense.pronunciation !== value.reading
        && !pronunciations.includes(sourceSense.pronunciation)
      ) {
        throw new Error("Source pronunciation was omitted");
      }
    }
    const senseKey = JSON.stringify([partOfSpeech, misc, field, dialect, pronunciations, pragmaticFunctions, glosses.map(({ lang, text }) => [lang, text])]);
    if (senseKeys.has(senseKey)) throw new Error("Duplicate sense");
    senseKeys.add(senseKey);
    return {
      id: stableId("sense", `${entryId}:${index + 1}`),
      position: index + 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech,
      ...(misc.length ? { misc } : {}),
      ...(field.length ? { field } : {}),
      ...(dialect.length ? { dialect } : {}),
      ...(pronunciations.length ? { pronunciations } : {}),
      ...(pragmaticFunctions.length ? { pragmaticFunctions } : {}),
      glosses,
      evidenceIds,
      provenance: sense.provenance
    };
  });
  if (Array.from(knownEvidence.keys()).some((id) => !usedEvidence.has(id))) throw new Error("Source meaning was omitted");

  const reading = value.reading.trim();
  return {
    id: entryId,
    word: expectedHeadword,
    reading,
    common: false,
    source: "generated",
    sourceId: entryId,
    headwordLanguage: "ja",
    headwords: [
      {
        text: expectedHeadword,
        reading,
        kind: /\p{Script=Han}/u.test(expectedHeadword) ? "kanji" : "kana",
        common: false,
        tags: []
      }
    ],
    senses
  };
}

function parseGlosses(value: unknown): PublicSense["glosses"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid gloss map");
  const map = value as Record<string, unknown>;
  assertExactKeys(map, ["en", "zh-tw"]);
  const en = requiredStringList(map.en);
  const zhTw = requiredStringList(map["zh-tw"]);
  if (en.length === 0 || zhTw.length === 0) throw new Error("Missing required gloss language");
  if (new Set(en).size !== en.length || new Set(zhTw).size !== zhTw.length) throw new Error("Duplicate gloss");
  if (zhTw.some((gloss) => findPrcTerms(gloss).length > 0 || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(gloss))) {
    throw new Error("Invalid Taiwan Chinese gloss");
  }
  return [
    ...en.map((text) => ({ text, lang: "en" as const, source: "generated" as const, reviewStatus: "checked" as const })),
    ...zhTw.map((text) => ({ text, lang: "zh-tw" as const, source: "generated" as const, reviewStatus: "checked" as const })),
    ...zhTw.map((text) => ({ text: toZhCn(text), lang: "zh-cn" as const, source: "generated" as const, reviewStatus: "checked" as const }))
  ];
}

const toZhCn = Converter({ from: "twp", to: "cn" });
const japaneseWordSegmenter = new Intl.Segmenter("ja-JP", { granularity: "word" });
const inflectionBoundaries = new Set(["は", "が", "を", "に", "へ", "と", "で", "も", "や", "か", "から", "まで", "より"]);

function parseExample(text: string, headword: string): PublicExample {
  const value = parseObject(text);
  assertExactKeys(value, ["sentence", "translations"]);
  if (typeof value.sentence !== "string" || !value.translations || typeof value.translations !== "object") {
    throw new Error("Invalid example");
  }
  const translations = value.translations as Record<string, unknown>;
  assertExactKeys(translations, ["en", "zh-tw"]);
  const en = typeof translations.en === "string" ? translations.en.trim() : "";
  const zhTw = typeof translations["zh-tw"] === "string" ? translations["zh-tw"].trim() : "";
  if (!sentenceContainsHeadword(value.sentence, headword) || !en || !zhTw || findPrcTerms(zhTw).length > 0) {
    throw new Error("Invalid example");
  }
  return {
    text: value.sentence,
    translations: [
      { lang: "en", text: en },
      { lang: "zh-tw", text: zhTw },
      { lang: "zh-cn", text: toZhCn(zhTw) }
    ],
    source: "generated",
    reviewStatus: "checked"
  };
}

function sentenceContainsHeadword(sentence: string, headword: string): boolean {
  const segments = Array.from(japaneseWordSegmenter.segment(sentence));
  if (segments.some(({ segment, isWordLike }) => Boolean(isWordLike) && segment === headword)) return true;
  const chars = Array.from(sentence);
  const wordBoundaries = new Set([0, chars.length]);
  const starts = new Set([0]);
  for (const segment of segments) {
    const start = Array.from(sentence.slice(0, segment.index)).length;
    const end = start + Array.from(segment.segment).length;
    wordBoundaries.add(start);
    wordBoundaries.add(end);
    if (!segment.isWordLike || inflectionBoundaries.has(segment.segment)) {
      starts.add(end);
    }
  }
  const headwordLength = Array.from(headword).length;
  for (let start = 0; start + headwordLength <= chars.length; start += 1) {
    if (
      wordBoundaries.has(start)
      && wordBoundaries.has(start + headwordLength)
      && chars.slice(start, start + headwordLength).join("") === headword
    ) return true;
  }
  for (let start = 0; start < chars.length; start += 1) {
    for (let end = start + 1; end <= Math.min(chars.length, start + Math.max(12, Array.from(headword).length + 8)); end += 1) {
      const token = chars.slice(start, end).join("");
      if (starts.has(start) && token === headword) return true;
      if (deinflect(token).some((candidate) =>
        candidate.text === headword && isStandaloneInflection(chars, start, end, headword)
      )) return true;
    }
  }
  return false;
}

function isStandaloneInflection(chars: string[], start: number, end: number, headword: string): boolean {
  const normalized = [...chars.slice(0, start), ...Array.from(headword), ...chars.slice(end)].join("");
  return Array.from(japaneseWordSegmenter.segment(normalized))
    .some(({ segment, isWordLike }) => Boolean(isWordLike) && segment === headword);
}

function reviewOutcome(text: string): "accepted" | "rejected" | "malformed" {
  const verdict = text.trim();
  if (verdict === "ACCEPT") return "accepted";
  if (verdict === "REJECT") return "rejected";
  return "malformed";
}

function recordOutcome(repository: EnrichmentRepository, attempt: AttemptRecord, outcome: string): void {
  persistAttempt(repository, { ...attempt, outcome });
}

function parseObject(text: string): Record<string, any> {
  const value = JSON.parse(text.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function invalidRequest(request: ResolveRequest): boolean {
  const query = request.query.trim();
  const lemma = request.context?.lemma?.trim();
  const reading = request.context?.reading?.trim();
  const sentence = request.context?.sentence?.trim();
  return !query
    || Array.from(query).length > 80
    || invalidText(query)
    || Boolean(lemma && (Array.from(lemma).length > 80 || invalidText(lemma)))
    || Boolean(reading && (
      Array.from(reading).length > 80
      || unsafePromptText(reading)
      || !/^[\p{Script=Hiragana}\p{Script=Katakana}・ー]+$/u.test(reading)
    ))
    || Boolean(sentence && (Array.from(sentence).length > 500 || unsafePromptText(sentence)));
}

function invalidText(value: string): boolean {
  return unsafePromptText(value)
    || /^\p{Number}+[\p{Number}\p{Punctuation}\s]*$/u.test(value);
}

function unsafePromptText(value: string): boolean {
  return /[\n\r\p{Cc}]/u.test(value) || /<[^>]+>|https?:\/\/|www\./i.test(value);
}

function isJapaneseLexicalText(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Z・ー]+$/u.test(value);
}

function relatedHeadword(request: ResolveRequest, headword: string): boolean {
  const inputs = [request.query, request.context?.lemma, request.context?.reading].filter(nonemptyString);
  if (inputs.includes(headword)) return true;
  if (inputs.some((input) => deinflect(input).some((candidate) => candidate.text === headword))) return true;
  const headwordHan = new Set(Array.from(headword).filter((char) => /\p{Script=Han}/u.test(char)));
  return headwordHan.size > 0 && inputs.some((input) => Array.from(input).some((char) => headwordHan.has(char)));
}

function stableId(kind: "entry" | "sense", value: string): string {
  return `yori:${kind === "entry" ? "e" : "s"}_generated_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function eligibilityPrompt(request: ResolveRequest): string {
  return [
    "Return exactly one canonical Japanese dictionary headword or SKIP.",
    "Skip wrong-language input, names, sentences, markup, URLs, numbers, fragments, and extraction noise.",
    "Keep genuine Japanese compounds, loanwords, initialisms, and uncommon lexical items.",
    `candidate: ${request.query}`,
    `lemma: ${request.context?.lemma ?? ""}`,
    `reading: ${request.context?.reading ?? ""}`,
    `sentence: ${request.context?.sentence ?? ""}`
  ].join("\n");
}

function entryAuthorPrompt(
  candidateId: string,
  headword: string,
  request: ResolveRequest,
  evidence: SourceEvidence[]
): string {
  return [
    "Author one canonical Japanese dictionary entry as JSON.",
    "Preserve every source meaning and evidence id. Separate distinct parts of speech, registers, domains, pronunciations, and pragmatic functions.",
    "Include every schema array; use an empty array when a field does not apply.",
    "You may add an established missing sense with provenance generated and no evidence ids.",
    "Use natural English and Taiwan Chinese glosses. Do not mechanically translate source wording.",
    `candidateId: ${candidateId}`,
    `headword: ${headword}`,
    `reading_hint: ${request.context?.reading ?? ""}`,
    `source_evidence: ${JSON.stringify(evidence)}`
  ].join("\n");
}

function exampleAuthorPrompt(candidateId: string, entry: PublicLookupItem, sense: PublicSense): string {
  return [
    "Write one natural, safe Japanese learner example for exactly this sense.",
    "Return JSON with sentence and English plus Taiwan Chinese translations.",
    `candidateId: ${candidateId}`,
    `headword: ${entry.word}`,
    `sense: ${JSON.stringify(sense)}`
  ].join("\n");
}

function reviewPrompt(candidateId: string, candidate: unknown): string {
  return [
    "Reject only. Return exactly ACCEPT or REJECT and nothing else. Never rewrite or explain.",
    "Check coverage, sense structure, pronunciation, labels, source provenance, Taiwan terminology, factual accuracy, and safety.",
    `candidateId: ${candidateId}`,
    `candidate: ${JSON.stringify(candidate)}`
  ].join("\n");
}

export const onDemandEvaluationContracts = {
  eligibility: {
    model: lunaModel,
    promptVersion: "eligibility-v1",
    prompt(candidate: string) {
      return eligibilityPrompt({ query: candidate, targetDictionary: "ja" });
    }
  },
  entryReview: {
    model: geminiReviewModel,
    promptVersion: "entry-review-v2",
    prompt: reviewPrompt
  }
} as const;

const englishEntrySchema = {
  name: "english_dictionary_entry",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      headword: { type: "string" },
      pronunciations: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { ipa: { type: "string" }, region: { type: "string" }, evidenceIds: stringArraySchema },
          required: ["ipa", "region", "evidenceIds"]
        }
      },
      senses: {
        type: "array", minItems: 1,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            partOfSpeech: { type: "string" }, definition: { type: "string" },
            registers: stringArraySchema, regions: stringArraySchema, domains: stringArraySchema,
            dated: { type: "boolean" }, usage: stringArraySchema,
            evidenceIds: stringArraySchema, provenance: { type: "string", enum: ["source", "generated"] }
          },
          required: [
            "partOfSpeech", "definition", "registers", "regions", "domains", "dated", "usage",
            "evidenceIds", "provenance"
          ]
        }
      }
    },
    required: ["headword", "pronunciations", "senses"]
  }
};

const englishExampleSchema = {
  name: "english_dictionary_example",
  schema: {
    type: "object", additionalProperties: false,
    properties: { sentence: { type: "string" } }, required: ["sentence"]
  }
};

function englishModelConfigs(selection: EnglishModelSelection) {
  return {
    eligibility: modelConfig("eligibility", selection.author, "english-eligibility-v1"),
    entryAuthor: modelConfig("entry-author", selection.author, "english-entry-author-v1", englishEntrySchema),
    entryReview: modelConfig("entry-review", selection.reviewer, "english-entry-review-v2"),
    exampleAuthor: modelConfig("example-author", selection.author, "english-example-author-v1", englishExampleSchema),
    exampleReview: modelConfig("example-review", selection.reviewer, "english-example-review-v2")
  };
}

export function createEnglishOnDemandDictionary(options: {
  repository: EnglishEnrichmentRepository;
  modelGateway: ModelGateway;
  models: EnglishModelSelection;
  concurrency?: number;
  timeoutMs?: number;
  limiter?: ModelCallLimiter;
  logger?: (summary: ModelRunSummary) => void;
}): EnglishOnDemandDictionary {
  if (!nonemptyString(options.models.author) || !nonemptyString(options.models.reviewer)) {
    throw new Error("English author and reviewer models must be configured explicitly");
  }
  const concurrency = positiveInteger(options.concurrency ?? 4, "Enrichment concurrency");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "Model timeout");
  const runLimited = options.limiter ?? createModelCallLimiter(concurrency);
  const inFlight = new Map<string, Promise<EnglishEntry | null>>();
  const locks = new Map<string, Promise<void>>();
  const runtime: EnglishRuntimeOptions = {
    repository: options.repository,
    modelGateway: {
      call(input) { return runLimited(() => callWithTimeout(options.modelGateway, input, timeoutMs)); }
    },
    modelConfigs: englishModelConfigs(options.models),
    locks,
    exampleLocks: new Map()
  };
  return {
    async resolve(request) {
      const traceId = request.traceId ?? crypto.randomUUID();
      return traceContext.run(traceId, () => runWithModelSummary("en", traceId, options.logger, async () => {
      if (request.targetDictionary !== "en") return null;
      const surface = normalizeEnglishHeadword(request.query);
      const lemma = request.context?.lemma ? normalizeEnglishHeadword(request.context.lemma) : "";
      const existing = options.repository.find(surface)
        ?? (lemma && lemma !== surface
          ? options.repository.find(lemma)
          : null);
      if (existing && existing.senses.every((sense) => sense.examples.length > 0)) return existing;
      if (invalidEnglishRequest(request)) return null;
      const key = englishRequestKey(request);
      if (options.repository.terminalOutcome(key)) return null;
      const running = inFlight.get(key);
      if (running) return running;
      const task = (existing ? stageAndCompleteEnglishEntry(existing, request.mode, runtime) : resolveMissingEnglish(request, runtime))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
      return task;
      }));
    }
  };
}

function stageAndCompleteEnglishEntry(
  entry: EnglishEntry,
  mode: ResolveRequest["mode"],
  options: EnglishRuntimeOptions
): Promise<EnglishEntry> {
  options.repository.saveEntry(entry);
  return completeEnglishExamples(entry, mode, options);
}

async function resolveMissingEnglish(
  request: ResolveRequest,
  options: EnglishRuntimeOptions
): Promise<EnglishEntry | null> {
  let headword = normalizeEnglishHeadword(request.context?.lemma || request.query);
  let sources = options.repository.findSources(headword);
  if (sources.length > 0) {
    const sourceHeadwords = new Map(sources.map((source) => [normalizeEnglishHeadword(source.headword), source.headword.trim()]));
    if (sourceHeadwords.size === 1) headword = sourceHeadwords.values().next().value as string;
    else {
      const decision = await englishEligibility(request, options);
      const lookupDecision = decision ? normalizeEnglishHeadword(decision) : "";
      if (!decision || !sourceHeadwords.has(lookupDecision)) return null;
      headword = sourceHeadwords.get(lookupDecision)!;
      sources = options.repository.findSources(headword);
    }
  } else {
    const decision = await englishEligibility(request, options);
    if (!decision || !relatedEnglishHeadword(request, decision)) return null;
    headword = decision;
    const existing = options.repository.find(headword);
    if (existing) return existing;
    sources = options.repository.findSources(headword);
  }
  const key = `entry:en:${normalizeEnglishHeadword(headword)}`;
  if (options.repository.terminalOutcome(key)) return null;
  return serializeByKey(options.locks, key, async () => {
    const existing = options.repository.find(headword);
    if (existing) return existing;
    if (options.repository.terminalOutcome(key)) return null;
    return authorEnglishEntry(request, headword, sources, key, options);
  });
}

async function englishEligibility(request: ResolveRequest, options: EnglishRuntimeOptions): Promise<string | null> {
  const result = await callAndRecord(
    options,
    options.modelConfigs.eligibility,
    englishEligibilityPrompt(request),
    request.mode,
    englishRequestKey(request)
  );
  if (!result) return null;
  const headword = result.text.trim();
  if (headword === "SKIP") {
    englishRecordOutcome(options.repository, result.attempt, "skipped");
    options.repository.saveTerminalOutcome(englishRequestKey(request), "skipped");
    return null;
  }
  if (headword.includes("\n") || !isEnglishLexicalText(headword)) {
    englishRecordOutcome(options.repository, result.attempt, "malformed");
    options.repository.saveTerminalOutcome(englishRequestKey(request), "malformed-eligibility");
    return null;
  }
  englishRecordOutcome(options.repository, result.attempt, "candidate");
  return headword.normalize("NFKC").replace(/\s+/g, " ");
}

async function authorEnglishEntry(
  request: ResolveRequest,
  headword: string,
  sources: EnglishSourceRecord[],
  terminalKey: string,
  options: EnglishRuntimeOptions
): Promise<EnglishEntry | null> {
  const entryId = englishStableId("entry", headword);
  const authored = await callAndRecord(
    options, options.modelConfigs.entryAuthor, englishEntryAuthorPrompt(entryId, headword, request, sources), request.mode, entryId
  );
  if (!authored) return null;
  let entry: EnglishEntry;
  try {
    entry = parseEnglishEntry(authored.text, entryId, headword, sources, authored.attempt);
  } catch {
    englishRecordOutcome(options.repository, authored.attempt, "malformed");
    options.repository.saveTerminalOutcome(terminalKey, "malformed-entry");
    return null;
  }
  englishRecordOutcome(options.repository, authored.attempt, "candidate");
  const reviewed = await callAndRecord(
    options,
    options.modelConfigs.entryReview,
    reviewPrompt(entryId, { entry, sourceEvidence: sources }),
    request.mode,
    entryId
  );
  if (!reviewed) return null;
  const outcome = reviewOutcome(reviewed.text);
  englishRecordOutcome(options.repository, reviewed.attempt, outcome);
  if (outcome !== "accepted") {
    options.repository.saveTerminalOutcome(terminalKey, outcome);
    return null;
  }
  options.repository.saveEntry(entry);
  return completeEnglishExamples(entry, request.mode, options);
}

async function completeEnglishExamples(
  entry: EnglishEntry,
  mode: ResolveRequest["mode"],
  options: EnglishRuntimeOptions
): Promise<EnglishEntry> {
  const completed = await Promise.all(entry.senses.map(async (sense) => {
    if (sense.examples.length > 0) return null;
    const candidateId = `${sense.id}:example`;
    if (options.repository.terminalOutcome(candidateId)) return null;
    return serializeByKey(options.exampleLocks, candidateId, async () => {
      if (options.repository.terminalOutcome(candidateId)) return null;
      const staged = options.repository.find(entry.headword)
        ?.senses.find((candidate) => candidate.id === sense.id)?.examples[0];
      if (staged) return staged;
      return completeEnglishExample(entry, sense, candidateId, mode, options);
    });
  }));
  return {
    ...entry,
    senses: entry.senses.map((sense, index) => completed[index]
      ? { ...sense, examples: [...sense.examples, completed[index]!] }
      : sense)
  };
}

async function completeEnglishExample(
  entry: EnglishEntry,
  sense: EnglishEntry["senses"][number],
  candidateId: string,
  mode: ResolveRequest["mode"],
  options: EnglishRuntimeOptions
): Promise<EnglishExample | null> {
    const authored = await callAndRecord(
      options, options.modelConfigs.exampleAuthor, englishExamplePrompt(candidateId, entry, sense), mode, candidateId
    );
    if (!authored) return null;
    let example: EnglishExample;
    try {
      const value = parseObject(authored.text);
      assertExactKeys(value, ["sentence"]);
      if (!nonemptyString(value.sentence) || !englishSentenceContains(value.sentence, entry.headword)) throw new Error("Invalid example");
      example = { text: value.sentence.trim(), source: "generated", reviewStatus: "checked" };
    } catch {
      englishRecordOutcome(options.repository, authored.attempt, "malformed");
      options.repository.saveTerminalOutcome(candidateId, "malformed-example");
      return null;
    }
    englishRecordOutcome(options.repository, authored.attempt, "candidate");
    const reviewed = await callAndRecord(
      options,
      options.modelConfigs.exampleReview,
      reviewPrompt(candidateId, { entry: { headword: entry.headword }, sense, example }),
      mode,
      candidateId
    );
    if (!reviewed) return null;
    const outcome = reviewOutcome(reviewed.text);
    englishRecordOutcome(options.repository, reviewed.attempt, outcome);
    if (outcome !== "accepted") {
      options.repository.saveTerminalOutcome(candidateId, outcome);
      return null;
    }
    options.repository.saveExample(sense.id, example);
    return example;
}

function parseEnglishEntry(
  text: string,
  entryId: string,
  expectedHeadword: string,
  sources: EnglishSourceRecord[],
  authorAttempt: AttemptRecord
): EnglishEntry {
  const value = parseObject(text);
  assertExactKeys(value, ["headword", "pronunciations", "senses"]);
  if (normalizeEnglishHeadword(value.headword) !== expectedHeadword || !Array.isArray(value.senses) || value.senses.length === 0) {
    throw new Error("Invalid English headword");
  }
  const knownSenseEvidence = new Map(sources.flatMap((source) => source.senses.map((sense) => [sense.evidenceId, sense] as const)));
  const knownPronunciationEvidence = new Map(
    sources.flatMap((source) => source.pronunciations.map((pronunciation) => [pronunciation.evidenceId, pronunciation] as const))
  );
  const usedEvidence = new Set<string>();
  const usedPronunciationEvidence = new Set<string>();
  const senses = value.senses.map((raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid English sense");
    const sense = raw as Record<string, unknown>;
    assertExactKeys(sense, [
      "partOfSpeech", "definition", "registers", "regions", "domains", "dated", "usage", "evidenceIds", "provenance"
    ]);
    if (!nonemptyString(sense.partOfSpeech) || !nonemptyString(sense.definition) || typeof sense.dated !== "boolean") {
      throw new Error("Invalid English sense content");
    }
    const evidenceIds = requiredStringList(sense.evidenceIds);
    if (sense.provenance !== "source" && sense.provenance !== "generated") throw new Error("Invalid provenance");
    if (sense.provenance === "source" && evidenceIds.length === 0) throw new Error("Missing source evidence");
    if (sense.provenance === "generated" && evidenceIds.length > 0) throw new Error("Generated sense claims evidence");
    for (const id of evidenceIds) {
      if (!knownSenseEvidence.has(id)) throw new Error("Unknown evidence");
      usedEvidence.add(id);
    }
    const registers = requiredStringList(sense.registers);
    const regions = requiredStringList(sense.regions);
    const domains = requiredStringList(sense.domains);
    const usage = requiredStringList(sense.usage);
    const supported = evidenceIds.map((id) => knownSenseEvidence.get(id)!);
    const expectedRegisters = new Set(supported.flatMap((source) => source.registers));
    const expectedRegions = new Set(supported.flatMap((source) => source.regions));
    const expectedDomains = new Set(supported.flatMap((source) => source.domains));
    const expectedUsage = new Set(supported.flatMap((source) => source.usage));
    if (supported.some((source) =>
      source.partOfSpeech !== sense.partOfSpeech
      || source.dated !== sense.dated
    )
      || (evidenceIds.length > 0 && (
        !sameStringSet(new Set(registers), expectedRegisters)
        || !sameStringSet(new Set(regions), expectedRegions)
        || !sameStringSet(new Set(domains), expectedDomains)
        || !sameStringSet(new Set(usage), expectedUsage)
      ))
    ) throw new Error("Source sense structure was changed");
    if (new Set(supported.map(englishSourceSenseIdentity)).size > 1) throw new Error("Distinct source senses were merged");
    return {
      id: englishStableId("sense", englishSenseIdentity(entryId, sense, evidenceIds)),
      position: index + 1,
      partOfSpeech: sense.partOfSpeech.trim(),
      definition: sense.definition.trim(),
      registers,
      regions,
      domains,
      dated: sense.dated,
      usage,
      examples: [],
      evidenceIds,
      provenance: sense.provenance,
      ...(sense.provenance === "generated" ? { generation: englishGenerationProvenance(authorAttempt) } : {})
    } as EnglishEntry["senses"][number];
  });
  if (Array.from(knownSenseEvidence.keys()).some((id) => !usedEvidence.has(id))) throw new Error("Source meaning was omitted");
  if (!Array.isArray(value.pronunciations)) throw new Error("Invalid pronunciations");
  const pronunciations = value.pronunciations.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid pronunciation");
    const item = raw as Record<string, unknown>;
    assertExactKeys(item, ["ipa", "region", "evidenceIds"]);
    const evidenceIds = requiredStringList(item.evidenceIds);
    if (!nonemptyString(item.ipa) || evidenceIds.some((id) => !knownPronunciationEvidence.has(id))) {
      throw new Error("Invalid pronunciation evidence");
    }
    for (const id of evidenceIds) {
      const source = knownPronunciationEvidence.get(id)!;
      if (source.ipa !== item.ipa.trim() || (source.region ?? "") !== (nonemptyString(item.region) ? item.region.trim() : "")) {
        throw new Error("Source pronunciation was changed");
      }
      usedPronunciationEvidence.add(id);
    }
    return { ipa: item.ipa.trim(), ...(nonemptyString(item.region) ? { region: item.region.trim() } : {}), evidenceIds };
  });
  if (Array.from(knownPronunciationEvidence.keys()).some((id) => !usedPronunciationEvidence.has(id))) {
    throw new Error("Source pronunciation was omitted");
  }
  return {
    id: entryId,
    dictionary: "en",
    headword: expectedHeadword,
    pronunciations,
    senses,
    sources: sources.map(({ source, sourceVersion, sourceEntryId, license, attribution }) => ({
      source, sourceVersion, sourceEntryId, license, attribution
    }))
  };
}

type EnglishRuntimeOptions = {
  repository: EnglishEnrichmentRepository;
  modelGateway: ModelGateway;
  modelConfigs: ReturnType<typeof englishModelConfigs>;
  locks: Map<string, Promise<void>>;
  exampleLocks: Map<string, Promise<void>>;
};

function englishRecordOutcome(repository: EnglishEnrichmentRepository, attempt: AttemptRecord, outcome: string): void {
  persistAttempt(repository, { ...attempt, outcome });
}

function englishEligibilityPrompt(request: ResolveRequest): string {
  return [
    "Return exactly one canonical English dictionary headword or SKIP.",
    "Skip names, non-English text, fragments, markup, URLs, numbers, and sentences.",
    "Keep genuine words, compounds, phrasal verbs, idioms, abbreviations, and established multiword expressions.",
    `candidate: ${request.query}`,
    `lemma: ${request.context?.lemma ?? ""}`,
    `sentence: ${request.context?.sentence ?? ""}`
  ].join("\n");
}

function englishEntryAuthorPrompt(
  candidateId: string,
  headword: string,
  request: ResolveRequest,
  sources: EnglishSourceRecord[]
): string {
  return [
    "Author one canonical English dictionary entry as JSON.",
    "Preserve every source meaning and evidence id. Keep parts of speech, pronunciations, registers, regions, domains, dated status, and usage distinct.",
    "Deduplicate only truly equivalent senses. You may add an established missing sense as generated with no evidence ids.",
    `candidateId: ${candidateId}`,
    `headword: ${headword}`,
    `context: ${request.context?.sentence ?? ""}`,
    `source_evidence: ${JSON.stringify(sources.map(({ rawRecord: _raw, ...source }) => source))}`
  ].join("\n");
}

function englishExamplePrompt(candidateId: string, entry: EnglishEntry, sense: EnglishEntry["senses"][number]): string {
  return [
    "Write one natural English sentence that demonstrates exactly this sense. Return JSON with sentence only.",
    `candidateId: ${candidateId}`,
    `headword: ${entry.headword}`,
    `sense: ${JSON.stringify(sense)}`
  ].join("\n");
}

function invalidEnglishRequest(request: ResolveRequest): boolean {
  const values = [request.query, request.context?.lemma].filter(nonemptyString);
  return values.length === 0
    || values.some((value) => !isEnglishLexicalText(value))
    || Boolean(request.context?.sentence && unsafePromptText(request.context.sentence));
}

function isEnglishLexicalText(value: string): boolean {
  const text = value.trim();
  return text.length > 0
    && Array.from(text).length <= 80
    && /^[\p{Script=Latin}\p{Mark}][\p{Script=Latin}\p{Mark}'’.\-/ ]*$/u.test(text)
    && /\p{Letter}/u.test(text)
    && !unsafePromptText(text);
}

function normalizeEnglishHeadword(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function relatedEnglishHeadword(request: ResolveRequest, headword: string): boolean {
  const inputs = [request.query, request.context?.lemma].filter(nonemptyString).map(normalizeEnglishHeadword);
  const canonical = normalizeEnglishHeadword(headword);
  return inputs.some((input) => input === canonical || englishInflections(canonical).has(input));
}

function englishInflections(headword: string): Set<string> {
  return new Set([headword, `${headword}s`, `${headword}es`, `${headword}ed`, `${headword}ing`]);
}

function englishSentenceContains(sentence: string, headword: string): boolean {
  const words = sentence.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{Letter}\p{Mark}'’-]+/gu) ?? [];
  return Array.from(englishInflections(headword), (form) =>
    form.match(/[\p{Letter}\p{Mark}'’-]+/gu) ?? []
  ).some((formWords) => formWords.length > 0 && words.some((_, start) =>
    formWords.every((word, offset) => words[start + offset] === word)
  ));
}

function englishStableId(kind: "entry" | "sense", value: string): string {
  const identity = kind === "entry" ? normalizeEnglishHeadword(value) : value;
  return `yori:en:${kind === "entry" ? "e" : "s"}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function englishRequestKey(request: ResolveRequest): string {
  return `request:en:${createHash("sha256").update(JSON.stringify({
    query: normalizeEnglishHeadword(request.query),
    lemma: request.context?.lemma ? normalizeEnglishHeadword(request.context.lemma) : "",
    sentence: request.context?.sentence?.trim() ?? ""
  })).digest("hex").slice(0, 20)}`;
}

function englishGenerationProvenance(attempt: AttemptRecord) {
  return {
    model: attempt.model,
    provider: attempt.provider,
    reasoningEffort: attempt.reasoningEffort,
    promptVersion: attempt.promptVersion,
    serviceTier: attempt.effectiveServiceTier ?? attempt.requestedServiceTier
  };
}

function englishSenseIdentity(
  entryId: string,
  sense: Record<string, unknown>,
  evidenceIds: string[]
): string {
  return JSON.stringify([
    entryId,
    [...evidenceIds].sort(),
    evidenceIds.length === 0 ? [
      sense.partOfSpeech,
      typeof sense.definition === "string" ? sense.definition.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") : "",
      requiredStringList(sense.registers).sort(),
      requiredStringList(sense.regions).sort(),
      requiredStringList(sense.domains).sort(),
      sense.dated,
      requiredStringList(sense.usage).sort()
    ] : null
  ]);
}

function englishSourceSenseIdentity(sense: EnglishSourceRecord["senses"][number]): string {
  return JSON.stringify([
    sense.definition.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " "),
    sense.partOfSpeech,
    [...sense.registers].sort(),
    [...sense.regions].sort(),
    [...sense.domains].sort(),
    sense.dated,
    [...sense.usage].sort()
  ]);
}

export function createEnglishOnDemandEvaluationContracts(models: EnglishModelSelection) {
  const configs = englishModelConfigs(models);
  return {
    eligibility: {
      ...configs.eligibility,
      prompt(candidate: string) { return englishEligibilityPrompt({ query: candidate, targetDictionary: "en" }); }
    },
    entryAuthor: {
      ...configs.entryAuthor,
      prompt(candidateId: string, headword: string, sources: EnglishSourceRecord[], sentence = "") {
        return englishEntryAuthorPrompt(candidateId, headword, {
          query: headword,
          targetDictionary: "en",
          ...(sentence ? { context: { sentence } } : {})
        }, sources);
      }
    },
    entryReview: { ...configs.entryReview, prompt: reviewPrompt }
  } as const;
}

function requiredStringList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(nonemptyString)) throw new Error("Expected a string array");
  return value.map((item) => item.trim());
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error("Unexpected object shape");
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boundedLog(value: string): string {
  return Array.from(value).slice(0, 8_000).join("");
}

async function serializeByKey<T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function createModelCallLimiter(concurrency: number): ModelCallLimiter {
  positiveInteger(concurrency, "Enrichment concurrency");
  let active = 0;
  const queue: Array<() => void> = [];
  return <T>(work: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const run = () => {
      active += 1;
      work().then(resolve, reject).finally(() => {
        active -= 1;
        queue.shift()?.();
      });
    };
    if (active < concurrency) run();
    else queue.push(run);
  });
}

function sameStringSet(actual: Set<string>, expected: Set<string>): boolean {
  return actual.size === expected.size && Array.from(actual).every((value) => expected.has(value));
}

function persistAttempt(
  repository: { recordAttempt(attempt: AttemptRecord): void },
  attempt: AttemptRecord
): void {
  repository.recordAttempt(attempt);
  const metrics = modelRunContext.getStore();
  if (!metrics) return;
  metrics.attempts += 1;
  metrics.outcomes[attempt.outcome] = (metrics.outcomes[attempt.outcome] ?? 0) + 1;
  metrics.inputTokens += attempt.inputTokens ?? 0;
  metrics.outputTokens += attempt.outputTokens ?? 0;
  metrics.costUsd += attempt.costUsd ?? 0;
}

function runWithModelSummary<T>(
  dictionary: TargetDictionary,
  traceId: string,
  logger: ((summary: ModelRunSummary) => void) | undefined,
  work: () => Promise<T>
): Promise<T> {
  const metrics: ModelRunMetrics = {
    attempts: 0,
    outcomes: {},
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0
  };
  return modelRunContext.run(metrics, async () => {
    try {
      return await work();
    } finally {
      if (metrics.attempts > 0) {
        logger?.({ event: "model_run_summary", traceId, dictionary, ...metrics });
      }
    }
  });
}

function callWithTimeout(gateway: ModelGateway, input: ModelRequest, timeoutMs: number): Promise<ModelResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  return new Promise<ModelResponse>((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      callback(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(reject, new ModelGatewayError("transient", "Model call timed out"));
    }, timeoutMs);
    gateway.call({ ...input, signal: controller.signal }).then(
      (response) => finish(resolve, response),
      (error) => finish(reject, error)
    );
  });
}
