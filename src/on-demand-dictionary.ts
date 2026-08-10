import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { findPrcTerms } from "../scripts/taiwan-terminology";
import { deinflect } from "./deinflect";
import { resolveEnglishLemma } from "./english-strip";
import type { ApiLang, InflectionStep, PublicExample, PublicLookupItem, PublicSense } from "./types";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "./english-types";
import type { LookupDictionary } from "./lookup-contract";

/**
 * Enrichment targets the same headword dictionaries lookup names, so the two
 * always agree on what a dictionary is.
 */
export type TargetDictionary = LookupDictionary;

const traceContext = new AsyncLocalStorage<string | undefined>();
const modelRunContext = new AsyncLocalStorage<ModelRunMetrics>();

/**
 * `lang` is the requested explanation language. It scopes every key that
 * bounds enrichment work or records its outcome, so work for one language
 * never blocks, deduplicates against, or stands in for another language.
 */
export type ResolveRequest = {
  query: string;
  targetDictionary: TargetDictionary;
  lang: ApiLang;
  traceId?: string;
  mode?: "on-demand" | "bulk";
  context?: {
    sentence?: string;
    lemma?: string;
    reading?: string;
  };
  /** Internal exact-match target used when enriching ranked alternatives. */
  candidate?: CanonicalCandidate;
};

export type CanonicalCandidate = {
  id: string;
  headword: string;
  inflectionPath?: InflectionStep[];
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

/** Full generation provenance kept beside canonical generated content. */
export type GenerationProvenance = {
  model: string;
  provider: string;
  reasoningEffort: string;
  promptVersion: string;
  serviceTier?: string;
  reviewOutcome: string;
  createdAt: string;
};

/**
 * Japanese enrichment persistence is scoped to one explanation language.
 * `saveEntry` writes exactly one entry-language group, so a rejection or a
 * retry in one language can never disturb another language's accepted content
 * for the same entry.
 */
export type EnrichmentRepository = {
  find(query: string, targetDictionary: TargetDictionary, lang: ApiLang): PublicLookupItem | null;
  findById?(id: string, lang: ApiLang, inflectionPath?: InflectionStep[]): PublicLookupItem | null;
  candidates?(query: string): CanonicalCandidate[];
  findSources(query: string, targetDictionary: TargetDictionary): SourceEvidence[];
  saveEntry(entry: PublicLookupItem, lang: ApiLang, generation?: GenerationProvenance): void;
  saveExample(senseId: string, example: PublicExample, generation?: GenerationProvenance): void;
  recordAttempt(attempt: AttemptRecord): void;
  labelVocabulary(): LabelVocabulary;
  /**
   * The canonical entry this query already resolves to in any explanation
   * language, or null. Filling a missing language group for an entry the
   * dictionary already knows needs no eligibility decision, and the authored
   * group must attach to that entry's own identity rather than minting a
   * second entry for the same headword.
   */
  canonicalEntry?(query: string): { id: string; headword: string } | null;
};

export type DictionaryResolver<TEntry> = {
  resolve(request: ResolveRequest): Promise<TEntry | null>;
  resolveAll?(request: ResolveRequest): Promise<ResolvedMatches<TEntry>>;
};

export type ResolvedMatches<TEntry> = {
  item: TEntry | null;
  alternatives: TEntry[];
  /** Candidates came from a fixed relevance tier; a missing first slot must not be promoted. */
  ranked?: boolean;
};

export type OnDemandEntry = PublicLookupItem | EnglishEntry;
export type OnDemandDictionary = DictionaryResolver<OnDemandEntry>;
export type JapaneseOnDemandDictionary = DictionaryResolver<PublicLookupItem>;

/**
 * English enrichment persistence is scoped to one explanation language, the
 * same contract Japanese uses. `saveEntry` writes exactly one entry-language
 * group, so a rejection or a retry in one language can never disturb another
 * language's accepted content for the same English headword.
 */
export type EnglishEnrichmentRepository = {
  find(query: string, lang: ApiLang): EnglishEntry | null;
  findById?(id: string, lang: ApiLang): EnglishEntry | null;
  candidates?(query: string): CanonicalCandidate[];
  /**
   * Every entry the query reaches, best first. `find` returns only the first;
   * public lookup hands the rest to the reader, because one spelling can be
   * several lexemes and the order is a ranking rather than a verdict.
   */
  findAll(query: string, lang: ApiLang): EnglishEntry[];
  /**
   * Whether this exact lookup term is stored, with no inflection stripping and
   * no explanation language. `find` resolves an inflected surface to its lemma,
   * which is right for answering a reader but useless for asking whether a
   * surface is itself an entry — the question the authoring guard needs.
   */
  hasLookupTerm(term: string): boolean;
  findSources(query: string): EnglishSourceRecord[];
  findSourcesById?(id: string): EnglishSourceRecord[];
  saveEntry(entry: EnglishEntry, lang: ApiLang, generation?: GenerationProvenance): void;
  saveExample(senseId: string, example: EnglishExample, generation?: GenerationProvenance): void;
  recordAttempt(attempt: AttemptRecord): void;
  labelVocabulary(): EnglishLabelVocabulary;
};

export type EnglishOnDemandDictionary = DictionaryResolver<EnglishEntry>;

export type ModelCallLimiter = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Model work is bounded once for both dictionaries. These were runtime
 * variables that nothing ever set, so the deployed values were always these.
 * Changing them is a code change, which is how the deployed value stays
 * visible to a reader.
 */
export const enrichmentConcurrency = 4;
export const modelTimeoutMs = 15_000;

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

/**
 * Why one enrichment attempt produced nothing. Nothing is persisted: the next
 * lookup for the same word tries again. This log line is the only record, so it
 * names the rule that refused the content and the value that broke it.
 */
export type EnrichmentRefusal = {
  event: "enrichment_refused";
  traceId: string;
  dictionary: TargetDictionary;
  lang: string;
  headword: string;
  stage: "eligibility" | "entry" | "example";
  reason: string;
};

export type EnrichmentLogger = (event: ModelRunSummary | EnrichmentRefusal) => void;

/**
 * The label codes an authored sense may use, one set per field, each read from
 * the codes the dictionary itself already uses. The author prompt lists exactly
 * these codes and validation accepts exactly these codes, so the model is never
 * asked to guess a vocabulary it has not been shown.
 */
export type EnglishLabelVocabulary = {
  partOfSpeech: Set<string>;
};

export type LabelVocabulary = {
  partOfSpeech: Set<string>;
  misc: Set<string>;
  field: Set<string>;
  dialect: Set<string>;
};

type ModelRunMetrics = Omit<ModelRunSummary, "event" | "traceId" | "dictionary">;

export function createOnDemandDictionary(options: {
  japanese: JapaneseOnDemandDictionary;
  english?: EnglishOnDemandDictionary;
}): OnDemandDictionary {
  return {
    resolve(request) {
      return request.targetDictionary === "en"
        ? options.english?.resolve(request) ?? Promise.resolve(null)
        : options.japanese.resolve(request);
    },
    async resolveAll(request) {
      const resolver = request.targetDictionary === "en" ? options.english : options.japanese;
      if (!resolver) return { item: null, alternatives: [] };
      if (resolver.resolveAll) return resolver.resolveAll(request);
      return { item: await resolver.resolve(request), alternatives: [] };
    }
  };
}

async function resolveRanked<TEntry>(
  request: ResolveRequest,
  candidates: CanonicalCandidate[],
  resolve: (request: ResolveRequest) => Promise<TEntry | null>
): Promise<ResolvedMatches<TEntry>> {
  if (candidates.length === 0) {
    return { item: await resolve(request), alternatives: [] };
  }
  const outcomes = await Promise.all(candidates.map(async (candidate) => {
    try {
      return { entry: await resolve({ ...request, candidate }), error: null };
    } catch (error) {
      if (error instanceof ModelGatewayError) return { entry: null, error };
      throw error;
    }
  }));
  if (outcomes.every(({ error }) => error !== null)) throw outcomes[0]!.error;
  const resolved = outcomes.map(({ entry }) => entry);
  return {
    item: resolved[0] ?? null,
    alternatives: resolved.slice(1).flatMap((entry) => entry === null ? [] : [entry]),
    ranked: true
  };
}

/**
 * Explanation languages Japanese enrichment can author. Each is authored as
 * its own independent group by its own request, so no language is produced by
 * converting or translating another one. Taiwanese and Simplified Chinese are
 * separate authored languages rather than character conversions of each other.
 */
const japaneseAuthoredLanguages = new Set<ApiLang>(["en", "de", "zh-tw", "zh-cn", "ko"]);

const japaneseLanguageNames: Record<ApiLang, string> = {
  en: "English",
  de: "German",
  "zh-tw": "Taiwan Mandarin Chinese written in traditional characters",
  "zh-cn": "Mainland Simplified Chinese",
  ko: "Korean",
  ja: "Japanese"
};

const kanaPattern = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hanPattern = /\p{Script=Han}/u;
const hangulPattern = /\p{Script=Hangul}/u;

/**
 * Deterministic per-language checks the author output must pass before review.
 * They reject content written in the wrong language rather than judging style.
 */
function invalidExplanationText(lang: ApiLang, text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  switch (lang) {
    case "en":
    case "de":
      return kanaPattern.test(value) || hanPattern.test(value) || hangulPattern.test(value);
    case "zh-tw":
      return kanaPattern.test(value) || hangulPattern.test(value) || !hanPattern.test(value)
        || findPrcTerms(value).length > 0;
    case "zh-cn":
      return kanaPattern.test(value) || hangulPattern.test(value) || !hanPattern.test(value);
    case "ko":
      return kanaPattern.test(value) || !hangulPattern.test(value);
    case "ja":
      return hangulPattern.test(value) || !(kanaPattern.test(value) || hanPattern.test(value));
  }
}

export function createJapaneseOnDemandDictionary(options: {
  repository: EnrichmentRepository;
  modelGateway: ModelGateway;
  concurrency?: number;
  timeoutMs?: number;
  limiter?: ModelCallLimiter;
  logger?: EnrichmentLogger;
}): JapaneseOnDemandDictionary {
  const concurrency = positiveInteger(options.concurrency ?? enrichmentConcurrency, "Enrichment concurrency");
  const timeoutMs = positiveInteger(options.timeoutMs ?? modelTimeoutMs, "Model timeout");
  const runLimited = options.limiter ?? createModelCallLimiter(concurrency);
  const entryInFlight = new Map<string, Promise<PublicLookupItem | null>>();
  const canonicalInFlight = new Map<string, Promise<unknown>>();
  const exampleInFlight = new Map<string, Promise<unknown>>();
  const runtime: RuntimeOptions = {
    repository: options.repository,
    modelGateway: {
      call(input) {
        return runLimited(() => callWithTimeout(options.modelGateway, input, timeoutMs));
      }
    },
    canonicalInFlight,
    exampleInFlight,
    ...(options.logger ? { logger: options.logger } : {})
  };

  const resolveCore = async (request: ResolveRequest): Promise<PublicLookupItem | null> => {
    if (request.targetDictionary !== "ja" || !japaneseAuthoredLanguages.has(request.lang)) return null;
    const existing = request.candidate
      ? options.repository.findById?.(
          request.candidate.id,
          request.lang,
          request.candidate.inflectionPath
        ) ?? null
      : invalidRequest(request)
        ? null
        : options.repository.find(request.query, request.targetDictionary, request.lang);
    if (invalidRequest(request)) return existing;
    if (existing && existing.senses.every((sense) => hasJapaneseExamplePair(sense, request.lang))) return existing;

    const key = `${effectiveMode(request.mode)}:${requestOutcomeKey(request)}`;
    const running = entryInFlight.get(key);
    if (running) return running;
    const task = (existing ? completeEntryExamples(runtime, existing, request) : resolveMissing(request, runtime))
      .finally(() => entryInFlight.delete(key));
    entryInFlight.set(key, task);
    return task;
  };
  const run = <T>(request: ResolveRequest, work: () => Promise<T>) => {
    const traceId = request.traceId ?? crypto.randomUUID();
    return traceContext.run(traceId, () => runWithModelSummary("ja", traceId, options.logger, work));
  };
  return {
    resolve(request) {
      return run(request, () => resolveCore(request));
    },
    resolveAll(request) {
      return run(request, () => resolveRanked(request, options.repository.candidates?.(request.query) ?? [], resolveCore));
    }
  };
}

const stringArraySchema = { type: "array", items: { type: "string" } };

/** An array whose members must be one of the dictionary's own label codes. */
function codeArraySchema(codes: Set<string>) {
  const listed = [...codes].sort();
  // A category the dictionary never uses has no code to offer. `enum: []` is not
  // a valid JSON Schema enum and the provider rejects the whole request before
  // the model runs, and strict structured output does not accept `maxItems`
  // either, so the constraint is left off. Validation still refuses any code the
  // dictionary cannot describe, and that refusal is logged and retried.
  return listed.length > 0
    ? { type: "array", items: { type: "string", enum: listed } }
    : stringArraySchema;
}

/**
 * The author schema carries the label codes as enums. A label is a closed set,
 * so the schema enforces it and the prompt does not have to describe it. This
 * is why the entry prompt says nothing about which codes exist.
 */
const entrySchemaFor = (vocabulary: LabelVocabulary, hasEvidence: boolean) => ({
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
            partOfSpeech: codeArraySchema(vocabulary.partOfSpeech),
            registers: codeArraySchema(vocabulary.misc),
            domains: codeArraySchema(vocabulary.field),
            dialect: codeArraySchema(vocabulary.dialect),
            pronunciations: stringArraySchema,
            pragmaticFunctions: stringArraySchema,
            glosses: stringArraySchema,
            evidenceIds: stringArraySchema,
            // With no source evidence there is no id a source sense could cite,
            // so `generated` is the only provenance that can validate.
            provenance: { type: "string", enum: hasEvidence ? ["source", "generated"] : ["generated"] }
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
});
const exampleSchema = {
  name: "dictionary_example",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sentence: { type: "string" },
      translation: { type: "string" }
    },
    required: ["sentence", "translation"]
  }
};

const lunaModel = "openai/gpt-5.6-luna";
const geminiReviewModel = "google/gemini-3-flash-preview";
/**
 * Both dictionaries author with Luna and review with Gemini. The reviewer stays
 * a different model family from the author, which is the property ADR-0008
 * requires. English carried these as runtime configuration while a blind
 * comparison was outstanding; an unset variable disabled English enrichment
 * silently, so the pair is pinned here and the comparison can repin it.
 */
const englishModels: EnglishModelSelection = { author: lunaModel, reviewer: geminiReviewModel };
const entryAuthorConfigFor = (vocabulary: LabelVocabulary, hasEvidence: boolean) =>
  modelConfig("entry-author", lunaModel, "entry-author-v2", entrySchemaFor(vocabulary, hasEvidence));
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

  if (request.candidate) {
    const evidence = options.repository
      .findSources(request.candidate.headword, request.targetDictionary)
      .filter((source) => source.headword === request.candidate!.headword);
    return authorForHeadword(request, options, request.candidate.headword, evidence);
  }

  let headword = request.context?.lemma?.trim() || request.query.trim();
  if (headword !== request.query.trim()) {
    const existing = options.repository.find(headword, request.targetDictionary, request.lang);
    if (existing) return completeEntryExamples(options, existing, request);
  }

  // The entry may already exist with only other languages' senses. That is a
  // missing language group, not an unknown word, so it is authored directly.
  const known = options.repository.canonicalEntry?.(request.query.trim())
    ?? (headword === request.query.trim() ? null : options.repository.canonicalEntry?.(headword))
    ?? null;
  if (known) {
    return authorForHeadword(
      request,
      options,
      known.headword,
      options.repository
        .findSources(known.headword, request.targetDictionary)
        .filter((source) => source.headword === known.headword)
    );
  }

  let evidence = options.repository.findSources(headword, request.targetDictionary);
  if (evidence.length > 0) {
    const sourceHeadwords = new Set(evidence.map((source) => source.headword));
    let sourceHeadword: string;
    if (sourceHeadwords.size === 1) {
      sourceHeadword = sourceHeadwords.values().next().value as string;
    } else {
      const eligibility = await eligibilityDecision(request, options);
      if (eligibility.kind === "refused") return null;
      if (!sourceHeadwords.has(eligibility.headword)) {
        logRefusal(options, request, "eligibility", eligibility.headword, "headword is unrelated to the sources");
        return null;
      }
      sourceHeadword = eligibility.headword;
    }
    if (sourceHeadword !== headword) {
      headword = sourceHeadword;
      const existing = options.repository.find(headword, request.targetDictionary, request.lang);
      if (existing) return completeEntryExamples(options, existing, request);
      evidence = options.repository.findSources(headword, request.targetDictionary);
    }
    evidence = evidence.filter((source) => source.headword === headword);
  }
  if (evidence.length === 0) {
    const eligibility = await eligibilityDecision(request, options);
    if (eligibility.kind === "refused") return null;
    if (!relatedHeadword(request, eligibility.headword)) {
      logRefusal(options, request, "eligibility", eligibility.headword, "headword is unrelated to the query");
      return null;
    }
    // Relatedness deinflects the inputs to reach the proposal, but never the
    // proposal itself, so an inflection of an unknown word could be authored
    // as a public headword. 送られ deinflects to 送る, and if 送る is already
    // an entry then 送られ is one of its forms, not a second lexeme — so the
    // proposal becomes 送る. Refusing instead would answer nothing while
    // holding the entry the reader asked for.
    const canonicalHeadword = inflectedJapaneseProposal(eligibility.headword, request, options)
      ?? eligibility.headword;
    if (canonicalHeadword !== headword) {
      headword = canonicalHeadword;
      const existing = options.repository.find(headword, request.targetDictionary, request.lang);
      if (existing) return completeEntryExamples(options, existing, request);
      evidence = options.repository.findSources(headword, request.targetDictionary);
    }
  }

  return authorForHeadword(request, options, headword, evidence);
}

/**
 * Authors one entry-language group under a lock keyed by entry and language,
 * so concurrent work in another language for the same entry is independent.
 */
function authorForHeadword(
  request: ResolveRequest,
  options: RuntimeOptions,
  headword: string,
  evidence: SourceEvidence[]
): Promise<PublicLookupItem | null> {
  return shareByKey(options.canonicalInFlight, entryOutcomeKey(request, headword), async () => {
    const existing = request.candidate
      ? options.repository.findById?.(request.candidate.id, request.lang, request.candidate.inflectionPath) ?? null
      : options.repository.find(headword, request.targetDictionary, request.lang);
    if (existing) return completeEntryExamples(options, existing, request);
    return authorEntry(request, options, headword, evidence);
  });
}

async function authorEntry(
  request: ResolveRequest,
  options: RuntimeOptions,
  headword: string,
  evidence: SourceEvidence[]
): Promise<PublicLookupItem | null> {
  // An entry shares one identity across explanation languages. When the
  // dictionary already knows this headword, the authored group joins that
  // entry instead of creating a second entry the read path would never see.
  const entryId = request.candidate?.id
    ?? options.repository.canonicalEntry?.(headword)?.id
    ?? stableId("entry", headword);
  const vocabulary = options.repository.labelVocabulary();
  const authored = await callAndRecord(
    options,
    entryAuthorConfigFor(vocabulary, evidence.length > 0),
    entryAuthorPrompt(entryId, headword, request, evidence),
    request.mode,
    entryId
  );

  let entry: PublicLookupItem;
  try {
    entry = parseAuthoredEntry(
      authored.text,
      entryId,
      headword,
      request.lang,
      evidence,
      vocabulary
    );
  } catch (error) {
    recordOutcome(options.repository, authored.attempt, "malformed");
    logRefusal(options, request, "entry", headword, refusalReason(error));
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
  const review = reviewOutcome(reviewed.text);
  recordOutcome(options.repository, reviewed.attempt, review);
  if (review !== "accepted") {
    logRefusal(options, request, "entry", headword, `reviewer returned ${review}`);
    return null;
  }

  // One author request produced one complete entry-language group and one
  // reviewer accepted it, so the group is persisted atomically for this
  // language alone.
  options.repository.saveEntry(entry, request.lang, acceptedGeneration(authored.attempt));
  // Read the group back so an authored language group on an existing entry
  // answers with that entry's own identity, written forms, and source facts
  // rather than the candidate's placeholder ones.
  const stored = request.candidate
    ? options.repository.findById?.(request.candidate.id, request.lang, request.candidate.inflectionPath) ?? entry
    : options.repository.find(headword, request.targetDictionary, request.lang) ?? entry;
  return completeEntryExamples(options, stored, request);
}

async function eligibilityDecision(
  request: ResolveRequest,
  options: RuntimeOptions
): Promise<
  | { kind: "candidate"; headword: string }
  | { kind: "refused" }
> {
  const config = modelConfig("eligibility", lunaModel, "eligibility-v1");
  const result = await callAndRecord(
    options,
    config,
    eligibilityPrompt(request),
    request.mode,
    requestOutcomeKey(request)
  );
  const line = result.text.trim();
  if (line === "SKIP") {
    recordOutcome(options.repository, result.attempt, "skipped");
    logRefusal(options, request, "eligibility", request.query, "model returned SKIP");
    return { kind: "refused" };
  }
  if (!line || line.includes("\n") || Array.from(line).length > 80 || invalidText(line)) {
    recordOutcome(options.repository, result.attempt, "malformed");
    logRefusal(options, request, "eligibility", request.query, `unreadable headword: ${JSON.stringify(line.slice(0, 80))}`);
    return { kind: "refused" };
  }
  recordOutcome(options.repository, result.attempt, "candidate");
  return { kind: "candidate", headword: line };
}

async function completeEntryExamples(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  request: ResolveRequest
): Promise<PublicLookupItem> {
  const examples = await Promise.all(entry.senses.map((sense) => {
    if (hasJapaneseExamplePair(sense, request.lang)) return Promise.resolve(null);
    return completeExample(options, entry, sense, request).catch(missingExample);
  }));
  return {
    ...entry,
    senses: entry.senses.map((sense, index) => examples[index]
      ? { ...sense, examples: [...(sense.examples ?? []), examples[index]!] }
      : sense)
  };
}

function hasJapaneseExamplePair(sense: PublicSense, lang: ApiLang): boolean {
  return (sense.examples ?? []).some((example) =>
    example.text.trim().length > 0
    && example.translations.some((translation) => translation.lang === lang && translation.text.trim().length > 0)
  );
}

/** A provider failure leaves this one example gap retryable without discarding correct content. */
function missingExample(error: unknown): null {
  if (error instanceof ModelGatewayError) return null;
  throw error;
}

async function completeExample(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  sense: PublicSense,
  request: ResolveRequest
): Promise<PublicExample | null> {
  return shareByKey(options.exampleInFlight, exampleOutcomeKey(request, sense.id), async () => {
    const canonicalEntry = request.candidate
      ? options.repository.findById?.(request.candidate.id, request.lang, request.candidate.inflectionPath) ?? null
      : options.repository.find(entry.word, "ja", request.lang);
    const canonical = canonicalEntry
      ?.senses.find((candidate) => candidate.id === sense.id)
      ?.examples?.find((example) =>
        example.text.trim().length > 0
        && example.translations.some((translation) =>
          translation.lang === request.lang && translation.text.trim().length > 0
        )
      );
    if (canonical) return canonical;
    return completeExampleWork(options, entry, sense, request);
  });
}

async function completeExampleWork(
  options: RuntimeOptions,
  entry: PublicLookupItem,
  sense: PublicSense,
  request: ResolveRequest
): Promise<PublicExample | null> {
  const mode = request.mode;
  const candidateId = `${sense.id}:example`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authored = await callAndRecord(
      options,
      exampleAuthorConfig,
      exampleAuthorPrompt(candidateId, entry, sense, request.lang),
      mode,
      candidateId
    );
    let example: PublicExample;
    try {
      example = parseExample(authored.text, entry.word, request.lang);
    } catch (error) {
      recordOutcome(options.repository, authored.attempt, "malformed");
      logRefusal(options, request, "example", entry.word, refusalReason(error));
      continue;
    }
    recordOutcome(options.repository, authored.attempt, "candidate");
    const reviewed = await callAndRecord(
      options,
      exampleReviewConfig,
      reviewPrompt(candidateId, { entry: { word: entry.word, reading: entry.reading }, sense, example }),
      mode,
      candidateId
    );
    const review = reviewOutcome(reviewed.text);
    recordOutcome(options.repository, reviewed.attempt, review);
    if (review !== "accepted") {
      logRefusal(options, request, "example", entry.word, `reviewer returned ${review}`);
      continue;
    }
    options.repository.saveExample(sense.id, example, acceptedGeneration(authored.attempt));
    return example;
  }
  return null;
}

/** Full provenance for content a reviewer accepted. */
function acceptedGeneration(attempt: AttemptRecord): GenerationProvenance {
  return {
    model: attempt.model,
    provider: attempt.provider,
    reasoningEffort: attempt.reasoningEffort,
    promptVersion: attempt.promptVersion,
    ...(attempt.effectiveServiceTier ? { serviceTier: attempt.effectiveServiceTier } : {}),
    reviewOutcome: "accepted",
    createdAt: new Date().toISOString()
  };
}

/**
 * Runs one model attempt under the tier retry policy. Every attempt is
 * recorded. When the provider cannot be reached the failure is thrown rather
 * than reported as absent content: an outage is an operational failure, not a
 * dictionary miss.
 */
async function callAndRecord(
  options: ModelCallRuntime,
  config: ModelConfig,
  prompt: string,
  mode: ResolveRequest["mode"],
  candidateId: string
): Promise<{ text: string; attempt: AttemptRecord }> {
  const tiers: ServiceTier[] = config.requestedServiceTier === "flex"
    ? mode === "bulk" ? ["flex", "flex", "flex"] : ["flex", "standard"]
    : ["standard"];
  let failure = new ModelGatewayError("permanent", "Model gateway made no attempt");
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
      failure = error instanceof ModelGatewayError
        ? error
        : new ModelGatewayError("permanent", error instanceof Error ? error.message : "Unknown model gateway error");
      persistAttempt(options.repository, {
        ...config,
        traceId: traceContext.getStore(),
        candidateId,
        requestedServiceTier,
        durationMs: Math.max(0, performance.now() - started),
        prompt: boundedLog(prompt),
        error: boundedLog(failure.message),
        outcome: failure.kind
      });
      if (failure.kind !== "transient" || requestedServiceTier !== "flex") throw failure;
    }
  }
  throw failure;
}

type ModelCallRuntime = {
  repository: { recordAttempt(attempt: AttemptRecord): void };
  modelGateway: ModelGateway;
};

type RuntimeOptions = {
  repository: EnrichmentRepository;
  modelGateway: ModelGateway;
  canonicalInFlight: Map<string, Promise<unknown>>;
  exampleInFlight: Map<string, Promise<unknown>>;
  logger?: EnrichmentLogger;
};

/**
 * Records why an attempt produced nothing. A refusal is never persisted, so a
 * later lookup for the same word starts fresh.
 */
function logRefusal(
  options: { logger?: EnrichmentLogger },
  request: ResolveRequest,
  stage: EnrichmentRefusal["stage"],
  headword: string,
  reason: string
): void {
  options.logger?.({
    event: "enrichment_refused",
    traceId: traceContext.getStore() ?? "",
    dictionary: request.targetDictionary,
    lang: request.lang,
    headword,
    stage,
    reason
  });
}

function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryOutcomeKey(request: ResolveRequest, headword: string): string {
  return `entry:${request.targetDictionary}:${request.lang}:${request.candidate?.id ?? headword.trim()}`;
}

function exampleOutcomeKey(request: ResolveRequest, senseId: string): string {
  return `example:${request.lang}:${senseId}`;
}

function requestOutcomeKey(request: ResolveRequest): string {
  const identity = JSON.stringify({
    query: request.query.trim(),
    candidateId: request.candidate?.id ?? "",
    lemma: request.context?.lemma?.trim() ?? "",
    reading: request.context?.reading?.trim() ?? "",
    sentence: request.context?.sentence?.trim() ?? ""
  });
  return `request:${request.targetDictionary}:${request.lang}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function effectiveMode(mode: ResolveRequest["mode"]): "on-demand" | "bulk" {
  return mode === "bulk" ? "bulk" : "on-demand";
}

/**
 * Parses one authored entry-language group. The author writes senses for a
 * single explanation language; nothing here derives one language from another.
 */
function parseAuthoredEntry(
  text: string,
  entryId: string,
  expectedHeadword: string,
  lang: ApiLang,
  evidence: SourceEvidence[],
  vocabulary: LabelVocabulary
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
    if (partOfSpeech.length === 0) throw new Error("Sense has no part of speech");
    const unknownPos = partOfSpeech.find((label) => !vocabulary.partOfSpeech.has(label));
    if (unknownPos) throw new Error(`Unknown part of speech: ${unknownPos}`);
    if (sense.provenance !== "source" && sense.provenance !== "generated") throw new Error("Invalid provenance");
    const evidenceIds = requiredStringList(sense.evidenceIds);
    if (sense.provenance === "source" && evidenceIds.length === 0) throw new Error("Source sense has no evidence");
    if (sense.provenance === "generated" && evidenceIds.length > 0) throw new Error("Generated sense claims source evidence");
    for (const evidenceId of evidenceIds) {
      if (!knownEvidence.has(evidenceId)) throw new Error("Unknown source evidence");
      usedEvidence.add(evidenceId);
    }
    const glosses = parseGlosses(sense.glosses, lang);
    const misc = requiredStringList(sense.registers);
    const field = requiredStringList(sense.domains);
    const dialect = requiredStringList(sense.dialect);
    const unknownLabel = misc.find((label) => !vocabulary.misc.has(label))
      ?? field.find((label) => !vocabulary.field.has(label))
      ?? dialect.find((label) => !vocabulary.dialect.has(label));
    if (unknownLabel) throw new Error(`Unknown label: ${unknownLabel}`);
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
    const senseKey = JSON.stringify([partOfSpeech, misc, field, dialect, pronunciations, pragmaticFunctions, glosses.map(({ text }) => text)]);
    if (senseKeys.has(senseKey)) throw new Error("Duplicate sense");
    senseKeys.add(senseKey);
    return {
      id: stableId("sense", `${entryId}:${lang}:${index + 1}`),
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
  if (Array.from(knownEvidence.keys()).some((id) => !usedEvidence.has(id))) throw new Error("Source sense was omitted");

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

function parseGlosses(value: unknown, lang: ApiLang): PublicSense["glosses"] {
  const glosses = requiredStringList(value);
  if (glosses.length === 0) throw new Error("Missing gloss");
  if (new Set(glosses).size !== glosses.length) throw new Error("Duplicate gloss");
  if (glosses.some((gloss) => invalidExplanationText(lang, gloss))) {
    throw new Error(`Gloss is not written in ${lang}`);
  }
  return glosses.map((text) => ({
    text,
    lang,
    source: "generated" as const,
    reviewStatus: "checked" as const
  }));
}

const japaneseWordSegmenter = new Intl.Segmenter("ja-JP", { granularity: "word" });
const inflectionBoundaries = new Set(["は", "が", "を", "に", "へ", "と", "で", "も", "や", "か", "から", "まで", "より"]);

/**
 * A generated example is a bilingual pair: the Japanese sentence and its
 * sentence in the sense's own explanation language. It carries no other
 * language, so it can only ever be shown under the sense that owns it.
 */
function parseExample(text: string, headword: string, lang: ApiLang): PublicExample {
  const value = parseObject(text);
  assertExactKeys(value, ["sentence", "translation"]);
  if (typeof value.sentence !== "string" || typeof value.translation !== "string") {
    throw new Error("Invalid example");
  }
  const translation = value.translation.trim();
  if (
    !sentenceContainsHeadword(value.sentence, headword)
    || invalidExplanationText(lang, translation)
  ) {
    throw new Error("Invalid example");
  }
  return {
    text: value.sentence,
    translations: [{ lang, text: translation }],
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

/**
 * The dictionary form a proposed Japanese headword reduces to, when that form
 * is already an entry, and null otherwise. The Japanese counterpart of the
 * English stripper guard: both refuse to mint a word form as a lexeme, each
 * reusing the reduction its own language already has.
 */
function inflectedJapaneseProposal(
  headword: string,
  request: ResolveRequest,
  options: RuntimeOptions
): string | null {
  for (const candidate of deinflect(headword)) {
    if (candidate.text === headword) continue;
    if (options.repository.find(candidate.text, request.targetDictionary, request.lang)) return candidate.text;
  }
  return null;
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
    `Author one canonical Japanese dictionary entry explained in ${japaneseLanguageNames[request.lang]}, as JSON.`,
    "Preserve every source sense and evidence id. Separate distinct parts of speech, registers, domains, pronunciations, and pragmatic functions.",
    "Include every schema array; use an empty array when a field does not apply.",
    "You may add an established missing sense with provenance generated and no evidence ids.",
    `Write every gloss as natural ${japaneseLanguageNames[request.lang]} dictionary wording. Divide senses the way a ${japaneseLanguageNames[request.lang]} dictionary would; do not translate another language's wording line by line.`,
    // The schema enumerates the label codes. This line exists only because the
    // model's observed failure was to translate them into the explanation
    // language; without it the codes are the one field it renders, not selects.
    "partOfSpeech, registers, domains, and dialect are codes from the schema. Select them; never translate them.",
    `candidateId: ${candidateId}`,
    `explanation_language: ${request.lang}`,
    `headword: ${headword}`,
    `reading_hint: ${request.context?.reading ?? ""}`,
    `source_evidence: ${JSON.stringify(evidence)}`
  ].join("\n");
}

function exampleAuthorPrompt(
  candidateId: string,
  entry: PublicLookupItem,
  sense: PublicSense,
  lang: ApiLang
): string {
  return [
    "Write one natural, safe Japanese learner example for exactly this sense.",
    `Return JSON with the Japanese sentence and one translation written in ${japaneseLanguageNames[lang]}.`,
    `candidateId: ${candidateId}`,
    `explanation_language: ${lang}`,
    `headword: ${entry.word}`,
    `sense: ${JSON.stringify(sense)}`
  ].join("\n");
}

/**
 * What a reviewer checks when the candidate is a whole entry with its own
 * pronunciations and source evidence.
 */
const entryReviewCriteria =
  "Check coverage, sense structure, pronunciation, labels, source provenance, Taiwan terminology, factual accuracy, and safety.";

/**
 * An explanation group is a different shape, and the criteria above reject every
 * well-formed one: the group is authored rather than imported, so it carries no
 * evidence ids, and pronunciations describe the entry rather than one language,
 * so it carries none. Asked to check provenance and pronunciation, a reviewer
 * finds both missing and refuses content that is exactly as specified.
 */
const languageGroupReviewCriteria = [
  "The candidate is one explanation group written in explanationLanguage for a headword.",
  "The group is authored, not imported: every sense is provenance generated with no evidence ids,",
  "and the group carries no pronunciations. Neither is a defect.",
  "Reference facts describe coverage to match, never wording to copy.",
  "Check that each definition is natural dictionary wording in explanationLanguage, that the sense",
  "division suits that language rather than mirroring the reference, that labels are right, that a",
  "zh-tw group uses Taiwan terminology, and that the content is accurate and safe."
].join(" ");

function reviewPrompt(candidateId: string, candidate: unknown, criteria: string = entryReviewCriteria): string {
  return [
    "Reject only. Return exactly ACCEPT or REJECT and nothing else. Never rewrite or explain.",
    criteria,
    `candidateId: ${candidateId}`,
    `candidate: ${JSON.stringify(candidate)}`
  ].join("\n");
}

export const onDemandEvaluationContracts = {
  eligibility: {
    model: lunaModel,
    promptVersion: "eligibility-v1",
    prompt(candidate: string) {
      return eligibilityPrompt({ query: candidate, targetDictionary: "ja", lang: "en" });
    }
  },
  entryReview: {
    model: geminiReviewModel,
    promptVersion: "entry-review-v2",
    prompt: reviewPrompt
  }
} as const;

/**
 * The deterministic check behind the author schema's part-of-speech enum. An
 * empty vocabulary admits nothing rather than everything: a dictionary with no
 * codes to offer has nothing to enrich, and refusing is logged and retried.
 */
function assertEnglishPartOfSpeech(value: string, vocabulary: EnglishLabelVocabulary): void {
  const label = value.trim();
  if (!vocabulary.partOfSpeech.has(label)) throw new Error(`Unknown part of speech: ${label}`);
}

/** Same reasoning as `codeArraySchema`, for a single required label. */
function englishPartOfSpeechSchema(vocabulary: EnglishLabelVocabulary) {
  const listed = [...vocabulary.partOfSpeech].sort();
  return listed.length > 0 ? { type: "string", enum: listed } : { type: "string" };
}

const englishEntrySchemaFor = (vocabulary: EnglishLabelVocabulary, languageGroup: boolean) => ({
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
            partOfSpeech: englishPartOfSpeechSchema(vocabulary),
            definition: { type: "string" },
            registers: stringArraySchema, regions: stringArraySchema, domains: stringArraySchema,
            dated: { type: "boolean" }, usage: stringArraySchema,
            evidenceIds: stringArraySchema,
            // A language group is written, never carried across from the English
            // senses, so `source` is the one value its parser always refuses.
            provenance: { type: "string", enum: languageGroup ? ["generated"] : ["source", "generated"] }
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
});

const englishExampleSchema = {
  name: "english_dictionary_example",
  schema: {
    type: "object", additionalProperties: false,
    properties: { sentence: { type: "string" } }, required: ["sentence"]
  }
};

/** A bilingual example keeps the English sentence and its target-language pair together. */
const englishBilingualExampleSchema = {
  name: "english_dictionary_bilingual_example",
  schema: {
    type: "object", additionalProperties: false,
    properties: { sentence: { type: "string" }, translation: { type: "string" } },
    required: ["sentence", "translation"]
  }
};

function englishModelConfigs(selection: EnglishModelSelection) {
  return {
    author: selection.author,
    eligibility: modelConfig("eligibility", selection.author, "english-eligibility-v1"),
    entryReview: modelConfig("entry-review", selection.reviewer, "english-entry-review-v3"),
    exampleAuthor: modelConfig("example-author", selection.author, "english-example-author-v1", englishExampleSchema),
    bilingualExampleAuthor: modelConfig(
      "example-author", selection.author, "english-bilingual-example-author-v1", englishBilingualExampleSchema
    ),
    exampleReview: modelConfig("example-review", selection.reviewer, "english-example-review-v2")
  };
}

/**
 * Explanation languages English enrichment can author. Each is one independent
 * sibling group under the same English entry: its own request, its own author
 * and reviewer, its own retries and persistence key. No
 * group is produced by converting or translating another one.
 */
const englishAuthoredLanguages = new Set<ApiLang>(["en", "ja", "zh-tw"]);

const englishExplanationLanguageNames: Partial<Record<ApiLang, string>> = {
  en: "English",
  ja: "Japanese",
  "zh-tw": "Taiwan Mandarin Chinese written in traditional characters"
};

export function createEnglishOnDemandDictionary(options: {
  repository: EnglishEnrichmentRepository;
  modelGateway: ModelGateway;
  models?: EnglishModelSelection;
  concurrency?: number;
  timeoutMs?: number;
  limiter?: ModelCallLimiter;
  logger?: EnrichmentLogger;
}): EnglishOnDemandDictionary {
  const concurrency = positiveInteger(options.concurrency ?? enrichmentConcurrency, "Enrichment concurrency");
  const timeoutMs = positiveInteger(options.timeoutMs ?? modelTimeoutMs, "Model timeout");
  const runLimited = options.limiter ?? createModelCallLimiter(concurrency);
  const inFlight = new Map<string, Promise<EnglishEntry | null>>();
  const canonicalInFlight = new Map<string, Promise<unknown>>();
  const runtime: EnglishRuntimeOptions = {
    repository: options.repository,
    modelGateway: {
      call(input) { return runLimited(() => callWithTimeout(options.modelGateway, input, timeoutMs)); }
    },
    modelConfigs: englishModelConfigs(options.models ?? englishModels),
    canonicalInFlight,
    exampleInFlight: new Map(),
    ...(options.logger ? { logger: options.logger } : {})
  };
  const resolveCore = async (request: ResolveRequest): Promise<EnglishEntry | null> => {
    if (request.targetDictionary !== "en" || !englishAuthoredLanguages.has(request.lang)) return null;
    const surface = normalizeEnglishHeadword(request.query);
    const lemma = request.context?.lemma ? normalizeEnglishHeadword(request.context.lemma) : "";
    const existing = request.candidate
      ? options.repository.findById?.(request.candidate.id, request.lang) ?? null
      : options.repository.find(surface, request.lang)
        ?? (lemma && lemma !== surface
          ? options.repository.find(lemma, request.lang)
          : null);
    if (existing && existing.senses.every((sense) => hasEnglishExamplePair(sense, request.lang))) return existing;
    if (invalidEnglishRequest(request)) return null;
    const key = englishRequestKey(request);
    const running = inFlight.get(key);
    if (running) return running;
    const task = (existing ? completeCanonicalEnglishEntry(existing, request, runtime) : resolveMissingEnglish(request, runtime))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  };
  const run = <T>(request: ResolveRequest, work: () => Promise<T>) => {
    const traceId = request.traceId ?? crypto.randomUUID();
    return traceContext.run(traceId, () => runWithModelSummary("en", traceId, options.logger, work));
  };
  return {
    resolve(request) {
      return run(request, () => resolveCore(request));
    },
    resolveAll(request) {
      return run(request, () => resolveRanked(request, options.repository.candidates?.(request.query) ?? [], resolveCore));
    }
  };
}

/**
 * A canonical entry is never rewritten. Imported senses stay exactly as the
 * pinned sources wrote them; only a missing complete example pair is filled in.
 */
function completeCanonicalEnglishEntry(
  entry: EnglishEntry,
  request: ResolveRequest,
  options: EnglishRuntimeOptions
): Promise<EnglishEntry> {
  return completeEnglishExamples(entry, request, options);
}

async function resolveMissingEnglish(
  request: ResolveRequest,
  options: EnglishRuntimeOptions
): Promise<EnglishEntry | null> {
  if (request.candidate) {
    const sources = options.repository.findSourcesById?.(request.candidate.id)
      ?? options.repository.findSources(request.candidate.headword);
    return shareByKey(options.canonicalInFlight, entryOutcomeKey(request, request.candidate.headword), async () => {
      const existing = options.repository.findById?.(request.candidate!.id, request.lang) ?? null;
      if (existing) return completeEnglishExamples(existing, request, options);
      return authorEnglishEntry(request, request.candidate!.headword, sources, options);
    });
  }
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
    // A model asked about an unknown surface will happily propose the surface
    // itself. An inflected form is not a lexeme, so a proposal that strips to
    // an entry the dictionary already carries becomes that entry rather than a
    // second, competing one for the same word. Answering nothing here would
    // waste a lemma we have just proved we hold — and would leave the reader
    // with a miss that no later enrichment can fill, because the next lookup
    // reaches exactly the same refusal.
    headword = inflectedEnglishProposal(decision, options.repository) ?? decision;
    const existing = options.repository.find(headword, request.lang);
    if (existing) return existing;
    sources = options.repository.findSources(headword);
  }
  const key = entryOutcomeKey(request, normalizeEnglishHeadword(headword));
  return shareByKey(options.canonicalInFlight, key, async () => {
    const existing = options.repository.find(headword, request.lang);
    if (existing) return completeEnglishExamples(existing, request, options);
    return authorEnglishEntry(request, headword, sources, options);
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
  const headword = result.text.trim();
  if (headword === "SKIP") {
    englishRecordOutcome(options.repository, result.attempt, "skipped");
    logRefusal(options, request, "eligibility", request.query, "model returned SKIP");
    return null;
  }
  if (headword.includes("\n") || !isEnglishLexicalText(headword)) {
    englishRecordOutcome(options.repository, result.attempt, "malformed");
    logRefusal(options, request, "eligibility", request.query, `unreadable headword: ${JSON.stringify(headword.slice(0, 80))}`);
    return null;
  }
  englishRecordOutcome(options.repository, result.attempt, "candidate");
  return headword.normalize("NFKC").replace(/\s+/g, " ");
}

async function authorEnglishEntry(
  request: ResolveRequest,
  headword: string,
  sources: EnglishSourceRecord[],
  options: EnglishRuntimeOptions
): Promise<EnglishEntry | null> {
  const entryId = request.candidate?.id ?? englishStableId("entry", headword);
  // One candidate id per entry *and* language, so two languages authored at the
  // same time never share a model request or its recorded attempt.
  const candidateId = englishCandidateId(entryId, request.lang);
  const vocabulary = options.repository.labelVocabulary();
  const authored = await callAndRecord(
    options,
    modelConfig(
      "entry-author",
      options.modelConfigs.author,
      "english-entry-author-v2",
      englishEntrySchemaFor(vocabulary, request.lang !== "en")
    ),
    englishEntryAuthorPrompt(candidateId, headword, request, sources),
    request.mode,
    candidateId
  );
  let entry: EnglishEntry;
  try {
    entry = parseEnglishEntry(authored.text, entryId, headword, request.lang, sources, authored.attempt, vocabulary);
  } catch (error) {
    englishRecordOutcome(options.repository, authored.attempt, "malformed");
    logRefusal(options, request, "entry", headword, refusalReason(error));
    return null;
  }
  englishRecordOutcome(options.repository, authored.attempt, "candidate");
  const reviewed = await callAndRecord(
    options,
    options.modelConfigs.entryReview,
    reviewPrompt(candidateId, {
      explanationLanguage: request.lang,
      entry,
      // English source facts are reference for another language, never the
      // sense list the group had to mirror.
      [request.lang === "en" ? "sourceEvidence" : "englishReferenceFacts"]: sources
    }, request.lang === "en" ? entryReviewCriteria : languageGroupReviewCriteria),
    request.mode,
    candidateId
  );
  const outcome = reviewOutcome(reviewed.text);
  englishRecordOutcome(options.repository, reviewed.attempt, outcome);
  if (outcome !== "accepted") {
    logRefusal(options, request, "entry", headword, `reviewer returned ${outcome}`);
    return null;
  }
  // One author request produced one complete entry-language group and one
  // reviewer accepted it, so the group is persisted atomically for this
  // language alone.
  options.repository.saveEntry(entry, request.lang, acceptedGeneration(authored.attempt));
  // Read the group back so an authored language group answers with the entry's
  // own pronunciations and source facts, exactly as a later lookup would. The
  // author writes senses only; it never writes those entry-level facts.
  const stored = request.candidate
    ? options.repository.findById?.(request.candidate.id, request.lang) ?? entry
    : options.repository.find(entry.headword, request.lang) ?? entry;
  return completeEnglishExamples(stored, request, options);
}

async function completeEnglishExamples(
  entry: EnglishEntry,
  request: ResolveRequest,
  options: EnglishRuntimeOptions
): Promise<EnglishEntry> {
  const completed = await Promise.all(entry.senses.map(async (sense) => {
    if (hasEnglishExamplePair(sense, request.lang)) return null;
    const candidateId = `${sense.id}:example`;
    return shareByKey(options.exampleInFlight, exampleOutcomeKey(request, sense.id), async () => {
      const canonicalEntry = request.candidate
        ? options.repository.findById?.(request.candidate.id, request.lang) ?? null
        : options.repository.find(entry.headword, request.lang);
      const canonical = canonicalEntry
        ?.senses.find((candidate) => candidate.id === sense.id)?.examples
        .find((example) => {
          if (example.text.trim().length === 0) return false;
          if (request.lang === "en") return true;
          return example.translations?.some((translation) =>
            translation.lang === request.lang && translation.text.trim().length > 0
          ) ?? false;
        });
      if (canonical) return canonical;
      return completeEnglishExample(entry, sense, candidateId, request, options);
    }).catch(missingExample);
  }));
  return {
    ...entry,
    senses: entry.senses.map((sense, index) => completed[index]
      ? { ...sense, examples: [...sense.examples, completed[index]!] }
      : sense)
  };
}

function hasEnglishExamplePair(sense: EnglishEntry["senses"][number], lang: ApiLang): boolean {
  return sense.examples.some((example) => {
    if (example.text.trim().length === 0) return false;
    if (lang === "en") return true;
    return example.translations?.some((translation) =>
      translation.lang === lang && translation.text.trim().length > 0
    ) ?? false;
  });
}

async function completeEnglishExample(
  entry: EnglishEntry,
  sense: EnglishEntry["senses"][number],
  candidateId: string,
  request: ResolveRequest,
  options: EnglishRuntimeOptions
): Promise<EnglishExample | null> {
  const mode = request.mode;
  const bilingual = request.lang !== "en";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authored = await callAndRecord(
      options,
      bilingual ? options.modelConfigs.bilingualExampleAuthor : options.modelConfigs.exampleAuthor,
      englishExamplePrompt(candidateId, entry, sense, request.lang),
      mode,
      candidateId
    );
    let example: EnglishExample;
    try {
      example = parseEnglishExample(authored.text, entry, request.lang);
    } catch (error) {
      englishRecordOutcome(options.repository, authored.attempt, "malformed");
      logRefusal(options, request, "example", entry.headword, refusalReason(error));
      continue;
    }
    englishRecordOutcome(options.repository, authored.attempt, "candidate");
    const reviewed = await callAndRecord(
      options,
      options.modelConfigs.exampleReview,
      reviewPrompt(candidateId, {
        explanationLanguage: request.lang,
        entry: { headword: entry.headword },
        sense,
        example
      }),
      mode,
      candidateId
    );
    const outcome = reviewOutcome(reviewed.text);
    englishRecordOutcome(options.repository, reviewed.attempt, outcome);
    if (outcome !== "accepted") {
      logRefusal(options, request, "example", entry.headword, `reviewer returned ${outcome}`);
      continue;
    }
    options.repository.saveExample(sense.id, example, acceptedGeneration(authored.attempt));
    return example;
  }
  return null;
}

/**
 * Parses one authored entry-language group for an English headword. The author
 * writes senses for a single explanation language; nothing here derives one
 * language from another, and nothing rewrites an imported sense.
 *
 * The English group is grounded in English source evidence. Every other
 * explanation language is an independent sibling group: it may read the English
 * facts but may not claim their evidence identifiers, is not required to
 * produce one sense per English sense, and is checked against the
 * target-language deterministic rules below.
 */
function parseEnglishEntry(
  text: string,
  entryId: string,
  expectedHeadword: string,
  lang: ApiLang,
  sources: EnglishSourceRecord[],
  authorAttempt: AttemptRecord,
  vocabulary: EnglishLabelVocabulary
): EnglishEntry {
  return lang === "en"
    ? parseEnglishCanonicalGroup(text, entryId, expectedHeadword, lang, sources, authorAttempt, vocabulary)
    : parseEnglishLanguageGroup(text, entryId, expectedHeadword, lang, sources, authorAttempt, vocabulary);
}

/**
 * Deterministic rules for an authored English→other-language group.
 *
 * They catch the failure modes a machine can see: text written in the wrong
 * language, Mainland terminology published as Taiwanese, and wording carried
 * across from the English group. They cannot tell fluent, independently divided
 * target-language wording from a fluent sense-by-sense translation; the
 * prompt and the separate reviewer carry that judgement.
 */
function parseEnglishLanguageGroup(
  text: string,
  entryId: string,
  expectedHeadword: string,
  lang: ApiLang,
  sources: EnglishSourceRecord[],
  authorAttempt: AttemptRecord,
  vocabulary: EnglishLabelVocabulary
): EnglishEntry {
  const value = parseObject(text);
  assertExactKeys(value, ["headword", "pronunciations", "senses"]);
  if (normalizeEnglishHeadword(value.headword) !== expectedHeadword || !Array.isArray(value.senses) || value.senses.length === 0) {
    throw new Error("Invalid English headword");
  }
  // Pronunciations describe the entry, not one explanation language, so a
  // language group neither restates nor may change them.
  if (!Array.isArray(value.pronunciations) || value.pronunciations.length > 0) {
    throw new Error("A language group must not restate entry pronunciations");
  }
  const englishWording = new Set(sources.flatMap((source) =>
    source.senses.flatMap((sense) => sense.glosses.map(englishTextIdentity))
  ));
  const generation = acceptedGeneration(authorAttempt);

  const senses = value.senses.map((raw: unknown, index: number): EnglishEntry["senses"][number] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid English sense");
    const sense = raw as Record<string, unknown>;
    assertExactKeys(sense, [
      "partOfSpeech", "definition", "registers", "regions", "domains", "dated", "usage", "evidenceIds", "provenance"
    ]);
    if (!nonemptyString(sense.partOfSpeech) || !nonemptyString(sense.definition) || typeof sense.dated !== "boolean") {
      throw new Error("Invalid English sense content");
    }
    // The group is written, not derived: it may not attach itself to an English
    // source sense, which is what a line-by-line translation would do.
    if (sense.provenance !== "generated") throw new Error("A language group sense is authored, not imported");
    if (requiredStringList(sense.evidenceIds).length > 0) throw new Error("A language group sense claims English evidence");
    // Part of speech stays in the shared English label vocabulary so packs and
    // canonical rows read the same way across languages. The schema enumerates
    // the codes for the model; this is the check that enforces them, so a
    // provider that ignores the enum, or a dictionary with no codes to offer,
    // cannot admit an invented label.
    assertEnglishPartOfSpeech(sense.partOfSpeech, vocabulary);
    const definition = sense.definition.trim();
    if (invalidExplanationText(lang, definition)) throw new Error(`Definition is not written in ${lang}`);
    if (englishWording.has(englishTextIdentity(definition))) throw new Error("Definition repeats the English group");

    const registers = requiredStringList(sense.registers);
    const regions = requiredStringList(sense.regions);
    const domains = requiredStringList(sense.domains);
    const usage = requiredStringList(sense.usage);
    return {
      id: englishStableId("sense", JSON.stringify([entryId, lang, index + 1, englishTextIdentity(definition)])),
      lang,
      position: index + 1,
      partOfSpeech: sense.partOfSpeech.trim(),
      glosses: [{ text: definition, source: "generated", reviewStatus: "checked" }],
      registers,
      regions,
      domains,
      dated: sense.dated,
      usage,
      examples: [],
      evidenceIds: [],
      provenance: "generated",
      generation
    };
  });
  if (new Set(senses.map((sense) => sense.id)).size !== senses.length) throw new Error("Duplicate language group sense");

  return {
    id: entryId,
    dictionary: "en",
    headword: expectedHeadword,
    // The entry keeps its own pronunciations; a language group never writes them.
    pronunciations: [],
    senses,
    sources: []
  };
}

/**
 * One generated example for one target-language sense. For English it is a
 * single sentence; for another explanation language it is a true bilingual
 * pair, the English sentence kept together with its target-language sentence.
 */
function parseEnglishExample(text: string, entry: EnglishEntry, lang: ApiLang): EnglishExample {
  const value = parseObject(text);
  assertExactKeys(value, lang === "en" ? ["sentence"] : ["sentence", "translation"]);
  if (!nonemptyString(value.sentence) || !englishSentenceContains(value.sentence, entry.headword)) {
    throw new Error("Invalid example");
  }
  const sentence = value.sentence.trim();
  if (invalidExplanationText("en", sentence)) throw new Error("The example sentence is not English");
  if (lang === "en") return { text: sentence, source: "generated", reviewStatus: "checked" };

  if (!nonemptyString(value.translation)) throw new Error("Invalid example translation");
  const translation = value.translation.trim();
  if (invalidExplanationText(lang, translation)) throw new Error(`The paired sentence is not written in ${lang}`);
  return {
    text: sentence,
    translations: [{ lang, text: translation }],
    source: "generated",
    reviewStatus: "checked"
  };
}

function englishTextIdentity(text: string): string {
  return text.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function englishCandidateId(entryId: string, lang: ApiLang): string {
  return `${entryId}:${lang}`;
}

function parseEnglishCanonicalGroup(
  text: string,
  entryId: string,
  expectedHeadword: string,
  lang: ApiLang,
  sources: EnglishSourceRecord[],
  authorAttempt: AttemptRecord,
  vocabulary: EnglishLabelVocabulary
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
    assertEnglishPartOfSpeech(sense.partOfSpeech, vocabulary);
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
      lang,
      position: index + 1,
      partOfSpeech: sense.partOfSpeech.trim(),
      glosses: [{
        text: sense.definition.trim(),
        source: sense.provenance === "generated" ? "generated" : evidenceSourceName(evidenceIds),
        reviewStatus: sense.provenance === "generated" ? "checked" : "source"
      }],
      registers,
      regions,
      domains,
      dated: sense.dated,
      usage,
      examples: [],
      evidenceIds,
      provenance: sense.provenance,
      ...(sense.provenance === "generated" ? { generation: acceptedGeneration(authorAttempt) } : {})
    } as EnglishEntry["senses"][number];
  });
  if (Array.from(knownSenseEvidence.keys()).some((id) => !usedEvidence.has(id))) throw new Error("Source sense was omitted");
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
    return {
      ipa: item.ipa.trim(),
      ...(nonemptyString(item.region) ? { region: item.region.trim() } : {}),
      source: evidenceSourceName(evidenceIds),
      ...(evidenceIds[0] ? { sourceRef: evidenceIds[0] } : {})
    };
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
  canonicalInFlight: Map<string, Promise<unknown>>;
  exampleInFlight: Map<string, Promise<unknown>>;
  logger?: EnrichmentLogger;
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
  const language = englishExplanationLanguageNames[request.lang] ?? request.lang;
  if (request.lang !== "en") {
    return [
      `Author the ${language} explanation group for one English headword, as JSON.`,
      `Write every definition as natural ${language} dictionary wording that a ${language} learner's dictionary would print.`,
      "Divide the senses the way a dictionary in that language would. Do not translate the English definitions line by line, and do not produce one sense per English sense unless that division is genuinely right.",
      "Every sense has provenance generated and an empty evidenceIds array. Return an empty pronunciations array.",
      `candidateId: ${candidateId}`,
      `explanation_language: ${request.lang}`,
      `headword: ${headword}`,
      `context: ${request.context?.sentence ?? ""}`,
      // English facts inform the author; they are not the sense list to copy.
      `english_reference_facts: ${JSON.stringify(sources)}`
    ].join("\n");
  }
  return [
    "Author one canonical English dictionary entry as JSON.",
    "Preserve every source sense and evidence id. Keep parts of speech, pronunciations, registers, regions, domains, dated status, and usage distinct.",
    "Deduplicate only truly equivalent senses. You may add an established missing sense as generated with no evidence ids.",
    `candidateId: ${candidateId}`,
    `headword: ${headword}`,
    `context: ${request.context?.sentence ?? ""}`,
    // Concise canonical evidence only; a complete raw source payload is never
    // put in front of a model.
    `source_evidence: ${JSON.stringify(sources)}`
  ].join("\n");
}

function englishExamplePrompt(
  candidateId: string,
  entry: EnglishEntry,
  sense: EnglishEntry["senses"][number],
  lang: ApiLang
): string {
  if (lang !== "en") {
    const language = englishExplanationLanguageNames[lang] ?? lang;
    return [
      "Write one natural, safe English learner sentence that demonstrates exactly this sense.",
      `Return JSON with that English sentence and its ${language} translation as a matching pair.`,
      `candidateId: ${candidateId}`,
      `explanation_language: ${lang}`,
      `headword: ${entry.headword}`,
      `sense: ${JSON.stringify(sense)}`
    ].join("\n");
  }
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

/**
 * The lemma a proposed English headword inflects from, when the dictionary
 * already carries it, and null otherwise. This is the deterministic half of
 * the same rule the English import applies to source records: one module
 * decides what an inflected surface is, so the import filter, lookup
 * resolution, and this guard cannot disagree.
 */
function inflectedEnglishProposal(
  headword: string,
  repository: EnglishEnrichmentRepository
): string | null {
  return resolveEnglishLemma(headword, (candidate) => repository.hasLookupTerm(candidate));
}

/**
 * Whether the proposal is the query, or the lemma the query inflects from.
 *
 * The reduction is Inflection Stripping's, asked one question: does this
 * surface strip to this word? A hand-rolled set of `+s`, `+es`, `+ed`, `+ing`
 * looks equivalent and is not — it rejected `running` from `run`, `studied`
 * from `study`, `bigger` from `big` and `pointier` from `pointy`, so a genuinely
 * new word first seen in one of those forms could never be authored.
 */
function relatedEnglishHeadword(request: ResolveRequest, headword: string): boolean {
  const inputs = [request.query, request.context?.lemma].filter(nonemptyString).map(normalizeEnglishHeadword);
  const canonical = normalizeEnglishHeadword(headword);
  return inputs.some((input) =>
    input === canonical || resolveEnglishLemma(input, (candidate) => candidate === canonical) !== null);
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
  return `request:en:${request.lang}:${createHash("sha256").update(JSON.stringify({
    query: normalizeEnglishHeadword(request.query),
    candidateId: request.candidate?.id ?? "",
    lemma: request.context?.lemma ? normalizeEnglishHeadword(request.context.lemma) : "",
    sentence: request.context?.sentence?.trim() ?? ""
  })).digest("hex").slice(0, 20)}`;
}

function evidenceSourceName(evidenceIds: string[]): string {
  return evidenceIds[0]?.split(":")[0] ?? "generated";
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
    sense.glosses.map((gloss) => gloss.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ")),
    sense.partOfSpeech,
    [...sense.registers].sort(),
    [...sense.regions].sort(),
    [...sense.domains].sort(),
    sense.dated,
    [...sense.usage].sort()
  ]);
}

export function createEnglishOnDemandEvaluationContracts(
  models: EnglishModelSelection,
  // The evaluation compares models on a fixture corpus, so it declares the
  // narrow label set those fixtures use. Production reads its vocabulary from
  // the dictionary instead.
  vocabulary: EnglishLabelVocabulary = { partOfSpeech: new Set(["noun", "verb", "adjective", "adverb"]) }
) {
  const configs = englishModelConfigs(models);
  return {
    eligibility: {
      ...configs.eligibility,
      prompt(candidate: string) { return englishEligibilityPrompt({ query: candidate, targetDictionary: "en", lang: "en" }); }
    },
    entryAuthor: {
      ...modelConfig("entry-author", configs.author, "english-entry-author-v2", englishEntrySchemaFor(vocabulary, false)),
      prompt(candidateId: string, headword: string, sources: EnglishSourceRecord[], sentence = "") {
        return englishEntryAuthorPrompt(candidateId, headword, {
          query: headword,
          targetDictionary: "en",
          lang: "en",
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

/**
 * Runs one operation per key and hands its result to every caller already
 * waiting on the same key, refusals included. Serializing instead would make
 * each waiter repeat the author and reviewer calls, because a refusal leaves
 * nothing behind for the next one to find. A caller that arrives after this
 * operation settles starts a fresh attempt, which is what keeps a refusal
 * retryable.
 */
function shareByKey<T>(inFlight: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  // A completed refusal is an answer and is shared. A rejection is an
  // operational failure: the work did not happen, so a caller waiting behind it
  // runs its own attempt, in its own service-tier mode, rather than inheriting
  // an error about someone else's provider call.
  if (running) return running.then((result) => result, () => shareByKey(inFlight, key, work));
  const task = work().finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
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
  logger: EnrichmentLogger | undefined,
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
