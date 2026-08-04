import { deinflect } from "./deinflect";
import { findPrcTerms } from "../scripts/taiwan-terminology";
import { Converter } from "opencc-js";
import { applyOverlay, type ExampleOverlay, type EnrichmentAttempt, type ModelProvenance } from "./example-overlay";
import type { PublicExample, PublicLookupItem, PublicSense } from "./types";

export const generatorConfig = {
  model: "gemini-2.5-flash",
  reasoningEffort: "low",
  provider: "google",
  allowFallbacks: false,
  requireParameters: true
} as const;

export const reviewerConfig = {
  model: "claude-haiku-4-5-20251001",
  reasoningEffort: "none",
  provider: "anthropic",
  allowFallbacks: false,
  requireParameters: true
} as const;

export const translatorConfig = {
  model: "gemini-2.5-flash-lite",
  reasoningEffort: "none",
  provider: "google",
  allowFallbacks: false,
  requireParameters: true
} as const;

export type ModelRole = "generator" | "translator" | "reviewer";
export type ModelCall = (input: {
  role: ModelRole;
  model: string;
  provider: string;
  reasoningEffort: string;
  allowFallbacks: false;
  requireParameters: true;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string>;

export type GenerationSeed = {
  senseId: string;
  word: string;
  reading: string | null;
  forms: Array<{ text: string; kind: "kanji" | "kana" }>;
  partOfSpeech: string[];
  tags: string[];
  targetSense: string[];
  otherSenses: string[][];
};

export type Generated =
  | { kind: "candidate"; sentence: string; translations: Array<{ lang: string; text: string }> }
  | { kind: "abstain"; reason: "archaic" | "too_technical" | "not_standalone" | "unclear_sense" };

export type JapaneseGeneration =
  | { kind: "candidate"; sentence: string; english: string }
  | { kind: "abstain"; reason: "archaic" | "too_technical" | "not_standalone" | "unclear_sense" };

export type ReviewDecision =
  | { decision: "accept" }
  | {
      decision: "reject";
      reason: "wrong_sense" | "unnatural" | "too_complex" | "translation_mismatch" | "zh_tw_style" | "unsafe_content";
    };

export type EnrichmentService = {
  overlay: ExampleOverlay;
  enrich(item: PublicLookupItem): Promise<PublicLookupItem>;
  enrichMany(items: PublicLookupItem[]): Promise<void>;
};

const abstainReasons = new Set(["archaic", "too_technical", "not_standalone", "unclear_sense"]);
export const reviewReasonCodes = [
  "wrong_sense",
  "unnatural",
  "too_complex",
  "translation_mismatch",
  "zh_tw_style",
  "unsafe_content"
] as const;
const reviewReasons = new Set<string>(reviewReasonCodes);

export function createEnrichmentService(options: {
  overlay: ExampleOverlay;
  modelCall: ModelCall;
  concurrency?: number;
  timeoutMs?: number;
}): EnrichmentService {
  const concurrency = positiveInteger(options.concurrency ?? 4, "Enrichment concurrency");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "Model timeout");
  const inFlight = new Map<string, Promise<void>>();
  const runLimited = createLimiter(concurrency);

  async function enrichMany(items: PublicLookupItem[]): Promise<void> {
    const bySense = new Map<string, GenerationSeed>();
    for (const item of items) {
      for (const seed of missingSeeds(item, options.overlay)) bySense.set(seed.senseId, seed);
    }
    await mapConcurrent(Array.from(bySense.values()), concurrency, async (seed) => {
      let task = inFlight.get(seed.senseId);
      if (!task) {
        task = runLimited(() => enrichSense(seed, options.overlay, options.modelCall, timeoutMs)).finally(() => {
          inFlight.delete(seed.senseId);
        });
        inFlight.set(seed.senseId, task);
      }
      await task;
    });
  }

  return {
    overlay: options.overlay,
    async enrich(item) {
      await enrichMany([item]);
      return applyOverlay(item, options.overlay) ?? item;
    },
    enrichMany
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function missingSeeds(item: PublicLookupItem, overlay: ExampleOverlay): GenerationSeed[] {
  const glosses = new Map(item.senses.map((sense) => [sense.id, sense.glosses.map((gloss) => gloss.text)]));
  return item.senses.flatMap((sense) => {
    const record = overlay.read(sense.id);
    if ((sense.examples?.length ?? 0) > 0 || (record && record.status !== "error")) return [];
    const seed = seedFor(item, sense, glosses);
    return seed ? [seed] : [];
  });
}

function seedFor(item: PublicLookupItem, sense: PublicSense, glosses: Map<string, string[]>): GenerationSeed | null {
  const forms = item.headwords
    .filter((form) => {
      const appliesTo = form.kind === "kanji" ? sense.appliesTo.kanji : sense.appliesTo.kana;
      return appliesTo.includes("*") || appliesTo.includes(form.text);
    })
    .map((form) => ({ text: form.text, kind: form.kind }));
  const word = forms.find((form) => form.text === item.word)?.text ?? forms.find((form) => form.kind === "kanji")?.text ?? forms[0]?.text;
  const reading = forms.find((form) => form.kind === "kana" && form.text === item.reading)?.text
    ?? forms.find((form) => form.kind === "kana")?.text
    ?? null;
  if (!word) return null;
  return {
    senseId: sense.id,
    word,
    reading,
    forms,
    partOfSpeech: sense.partOfSpeech,
    tags: sense.misc ?? [],
    targetSense: sense.glosses.map((gloss) => gloss.text),
    otherSenses: item.senses.filter((other) => other.id !== sense.id).map((other) => glosses.get(other.id) ?? [])
  };
}

async function enrichSense(
  seed: GenerationSeed,
  overlay: ExampleOverlay,
  modelCall: ModelCall,
  timeoutMs: number
): Promise<void> {
  const previous = overlay.read(seed.senseId);
  const attempts: EnrichmentAttempt[] = previous?.status === "error" ? [...previous.attempts] : [];
  let priorRejection: string | null = null;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const candidateId = `${seed.senseId}:${attempts.length + 1}`;
    const baseAttempt: EnrichmentAttempt = {
      candidateId,
      generator: provenance(generatorConfig)
    };
    let japanese: JapaneseGeneration;
    try {
      const raw = await callWithTimeout(
        modelCall,
        {
          role: "generator",
          model: generatorConfig.model,
          provider: generatorConfig.provider,
          reasoningEffort: generatorConfig.reasoningEffort,
          allowFallbacks: generatorConfig.allowFallbacks,
          requireParameters: generatorConfig.requireParameters,
          prompt: generatorPrompt(seed, priorRejection),
          signal: new AbortController().signal
        },
        timeoutMs
      );
      try {
        japanese = parseGeneration(raw);
      } catch {
        priorRejection = "malformed_generator";
        attempts.push({ ...baseAttempt, rejectionReason: priorRejection });
        continue;
      }
    } catch (error) {
      const reason = transportReason("generator", error);
      attempts.push({ ...baseAttempt, rejectionReason: reason });
      overlay.write({ senseId: seed.senseId, status: "error", attempts, reason });
      return;
    }

    if (japanese.kind === "abstain") {
      attempts.push({ ...baseAttempt, rejectionReason: japanese.reason });
      overlay.write({ senseId: seed.senseId, status: "abstained", attempts, reason: japanese.reason });
      return;
    }

    const translatedAttempt = { ...baseAttempt, translator: provenance(translatorConfig) };
    let zhTw: string;
    try {
      const raw = await callWithTimeout(
        modelCall,
        {
          role: "translator",
          model: translatorConfig.model,
          provider: translatorConfig.provider,
          reasoningEffort: translatorConfig.reasoningEffort,
          allowFallbacks: translatorConfig.allowFallbacks,
          requireParameters: translatorConfig.requireParameters,
          prompt: translatorPrompt(seed, japanese),
          signal: new AbortController().signal
        },
        timeoutMs
      );
      try {
        zhTw = parseTranslation(raw);
      } catch {
        priorRejection = "malformed_translator";
        attempts.push({
          ...translatedAttempt,
          candidate: partialExample(japanese),
          rejectionReason: priorRejection
        });
        continue;
      }
    } catch (error) {
      const reason = transportReason("translator", error);
      const example = partialExample(japanese);
      attempts.push({ ...translatedAttempt, candidate: example, rejectionReason: reason });
      overlay.write({ senseId: seed.senseId, status: "error", example, attempts, reason });
      return;
    }

    const generated = combineTranslations(japanese, zhTw);

    const example: PublicExample = {
      text: generated.sentence,
      translations: generated.translations,
      source: "generated",
      reviewStatus: "checked"
    };
    const filterReasons = filterCandidate(seed, generated);
    if (filterReasons.length > 0) {
      priorRejection = `deterministic_filter:${filterReasons.join(",")}`;
      attempts.push({ ...translatedAttempt, candidate: example, rejectionReason: priorRejection });
      continue;
    }

    let review: ReviewDecision;
    try {
      const raw = await callWithTimeout(
        modelCall,
        {
          role: "reviewer",
          model: reviewerConfig.model,
          provider: reviewerConfig.provider,
          reasoningEffort: reviewerConfig.reasoningEffort,
          allowFallbacks: reviewerConfig.allowFallbacks,
          requireParameters: reviewerConfig.requireParameters,
          prompt: reviewerPrompt(candidateId, seed, generated),
          signal: new AbortController().signal
        },
        timeoutMs
      );
      try {
        review = parseReview(raw, candidateId);
      } catch {
        priorRejection = "malformed_reviewer";
        attempts.push({
          ...translatedAttempt,
          reviewer: provenance(reviewerConfig),
          candidate: example,
          rejectionReason: priorRejection
        });
        continue;
      }
    } catch (error) {
      const reason = transportReason("reviewer", error);
      attempts.push({
        ...translatedAttempt,
        reviewer: provenance(reviewerConfig),
        candidate: example,
        rejectionReason: reason
      });
      overlay.write({ senseId: seed.senseId, status: "error", example, attempts, reason });
      return;
    }

    const reviewedAttempt = { ...translatedAttempt, reviewer: provenance(reviewerConfig), candidate: example };
    if (review.decision === "accept") {
      attempts.push(reviewedAttempt);
      overlay.write({ senseId: seed.senseId, status: "accepted", example, attempts });
      return;
    }
    priorRejection = review.reason;
    attempts.push({ ...reviewedAttempt, rejectionReason: review.reason });
  }

  overlay.write({
    senseId: seed.senseId,
    status: "dropped",
    attempts,
    reason: priorRejection ?? "rejected"
  });
}

function partialExample(japanese: Extract<JapaneseGeneration, { kind: "candidate" }>): PublicExample {
  return {
    text: japanese.sentence,
    translations: [{ lang: "en", text: japanese.english }],
    source: "generated",
    reviewStatus: "checked"
  };
}

export function parseGeneration(text: string): JapaneseGeneration {
  const parsed = parseObject(text) as Record<string, unknown>;
  if (parsed.abstain === true) {
    if (typeof parsed.reason !== "string" || !abstainReasons.has(parsed.reason)) {
      throw new Error("Generator returned an invalid abstention reason");
    }
    return { kind: "abstain", reason: parsed.reason as "archaic" | "too_technical" | "not_standalone" | "unclear_sense" };
  }
  if (typeof parsed.sentence !== "string" || typeof parsed.english !== "string" || !parsed.english.trim()) {
    throw new Error("Generator returned an invalid candidate");
  }
  return {
    kind: "candidate",
    sentence: parsed.sentence,
    english: parsed.english
  };
}

export function parseTranslation(text: string): string {
  const parsed = parseObject(text) as Record<string, unknown>;
  if (typeof parsed.translation !== "string" || !parsed.translation.trim() || Object.keys(parsed).length !== 1) {
    throw new Error("Translator returned an invalid translation");
  }
  return parsed.translation.trim();
}

const toZhCn = Converter({ from: "twp", to: "cn" });

export function combineTranslations(
  japanese: Extract<JapaneseGeneration, { kind: "candidate" }>,
  zhTw: string
): Extract<Generated, { kind: "candidate" }> {
  return {
    kind: "candidate",
    sentence: japanese.sentence,
    translations: [
      { lang: "en", text: japanese.english },
      { lang: "zh-tw", text: zhTw },
      { lang: "zh-cn", text: toZhCn(zhTw) }
    ]
  };
}

export function parseReview(text: string, candidateId: string): ReviewDecision {
  const parsed = parseObject(text) as Record<string, unknown>;
  if (parsed.id !== candidateId) throw new Error("Reviewer returned the wrong candidate id");
  const keys = Object.keys(parsed).sort();
  if (parsed.decision === "accept" && JSON.stringify(keys) === JSON.stringify(["decision", "id"])) {
    return { decision: "accept" };
  }
  if (
    parsed.decision === "reject" &&
    typeof parsed.reason === "string" &&
    reviewReasons.has(parsed.reason) &&
    JSON.stringify(keys) === JSON.stringify(["decision", "id", "reason"])
  ) {
    return {
      decision: "reject",
      reason: parsed.reason as "wrong_sense" | "unnatural" | "too_complex" | "translation_mismatch" | "zh_tw_style" | "unsafe_content"
    };
  }
  throw new Error("Reviewer returned an invalid decision shape");
}

export function filterCandidate(seed: GenerationSeed, candidate: Extract<Generated, { kind: "candidate" }>): string[] {
  const reasons: string[] = [];
  const length = Array.from(candidate.sentence).length;
  if (length < 10 || length > 30) reasons.push("sentence_length");
  if (/\n/.test(candidate.sentence) || (candidate.sentence.match(/[。！？!?]/g)?.length ?? 0) !== 1) {
    reasons.push("not_one_sentence");
  }
  const translations = new Map(candidate.translations.map((translation) => [translation.lang, translation.text.trim()]));
  if (!translations.get("en")) reasons.push("missing_en_translation");
  if (!translations.get("zh-tw")) reasons.push("missing_zh_tw_translation");
  const zhTw = translations.get("zh-tw");
  if (zhTw && findPrcTerms(zhTw).length > 0) reasons.push("zh_tw_style");
  if (!containsTarget(seed, candidate.sentence)) reasons.push("word_absent");
  if (seed.tags.includes("uk") && seed.forms.some((form) => form.kind === "kanji" && candidate.sentence.includes(form.text))) {
    reasons.push("wrong_uk_orthography");
  }
  return reasons;
}

export function generatorPrompt(seed: GenerationSeed, rejection: string | null): string {
  return [
    "Write one Japanese example sentence for a learner's dictionary.",
    "Return JSON only: {\"sentence\":\"...\",\"english\":\"...\"}",
    "Or abstain: {\"abstain\":true,\"reason\":\"archaic|too_technical|not_standalone|unclear_sense\"}",
    "The sentence must be natural modern Japanese, 10-30 characters, exactly one sentence, standalone, and use the target meaning rather than another sense.",
    "Use kana when tags include uk. Do not name real people, places, brands, or events.",
    `word: ${seed.word}`,
    `reading: ${seed.reading ?? ""}`,
    `forms: ${JSON.stringify(seed.forms)}`,
    `partOfSpeech: ${JSON.stringify(seed.partOfSpeech)}`,
    `tags: ${JSON.stringify(seed.tags)}`,
    `targetSense: ${JSON.stringify(seed.targetSense)}`,
    `otherSenses: ${JSON.stringify(seed.otherSenses)}`,
    ...(rejection ? [`The previous candidate was rejected for: ${rejection}. Produce a different candidate.`] : [])
  ].join("\n");
}

export function translatorPrompt(
  seed: GenerationSeed,
  generated: Extract<JapaneseGeneration, { kind: "candidate" }>
): string {
  return [
    "Translate this Japanese example sentence into Traditional Chinese used in Taiwan.",
    "Return JSON only: {\"translation\":\"...\"}",
    "Translate the sentence, not the dictionary gloss. Use Taiwanese vocabulary such as 軟體, 資訊, 影片, and 螢幕.",
    `word: ${seed.word}`,
    `forms: ${JSON.stringify(seed.forms)}`,
    `targetSense: ${JSON.stringify(seed.targetSense)}`,
    `sentence: ${generated.sentence}`,
    `english: ${generated.english}`
  ].join("\n");
}

export function reviewerPrompt(id: string, seed: GenerationSeed, candidate: Extract<Generated, { kind: "candidate" }>): string {
  return [
    "Judge this generated example. Never rewrite it and never return prose.",
    "Accept only if it uses targetSense (not otherSenses), is natural and appropriately simple, translations match, zh-tw uses Taiwanese vocabulary, and it contains no real-world claims.",
    "Return exactly one JSON object in one of these shapes:",
    `{\"id\":\"${id}\",\"decision\":\"accept\"}`,
    `{\"id\":\"${id}\",\"decision\":\"reject\",\"reason\":\"wrong_sense|unnatural|too_complex|translation_mismatch|zh_tw_style|unsafe_content\"}`,
    `word: ${seed.word}`,
    `forms: ${JSON.stringify(seed.forms)}`,
    `targetSense: ${JSON.stringify(seed.targetSense)}`,
    `otherSenses: ${JSON.stringify(seed.otherSenses)}`,
    `candidate: ${JSON.stringify(candidate)}`
  ].join("\n");
}

function containsTarget(seed: GenerationSeed, sentence: string): boolean {
  const allowedForms = new Set(
    seed.forms
      .filter((form) => !seed.tags.includes("uk") || form.kind === "kana")
      .map((form) => form.text)
  );
  if (Array.from(allowedForms).some((form) => sentence.includes(form))) return true;
  const chars = Array.from(sentence.replace(/[。！？!?]/g, ""));
  for (let start = 0; start < chars.length; start += 1) {
    for (let end = start + 1; end <= Math.min(chars.length, start + 12); end += 1) {
      const token = chars.slice(start, end).join("");
      if (deinflect(token).some((candidate) => allowedForms.has(candidate.text))) return true;
    }
  }
  return false;
}

async function mapConcurrent<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item) await worker(item);
      }
    })
  );
}

function createLimiter(concurrency: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export async function callWithTimeout(
  modelCall: ModelCall,
  input: Parameters<ModelCall>[0],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      modelCall({ ...input, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Model call timed out"));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function provenance(config: { model: string; reasoningEffort: string; provider: string }): ModelProvenance {
  return { model: config.model, reasoningEffort: config.reasoningEffort, provider: config.provider };
}

function parseObject(text: string): unknown {
  const trimmed = text.trim();
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function transportReason(role: ModelRole, error: unknown): string {
  return error instanceof Error && error.message === "Model call timed out"
    ? `${role}_timeout`
    : `${role}_error`;
}

export function makeGeminiRequestBody(input: Pick<Parameters<ModelCall>[0], "prompt" | "reasoningEffort">) {
  return {
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: input.reasoningEffort === "none" ? 0 : 1024 }
    }
  };
}

export const defaultModelCall: ModelCall = async (input) => {
  if (input.allowFallbacks || !input.requireParameters) {
    throw new Error("Model routing must disable fallbacks and require every request parameter");
  }
  if (input.role === "generator" || input.role === "translator") {
    const apiKey = input.role === "translator" ? process.env.GEMINI_ZH_TW_API_KEY : process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error(`${input.role === "translator" ? "GEMINI_ZH_TW_API_KEY" : "GEMINI_API_KEY"} is not configured`);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: input.signal,
        body: JSON.stringify(makeGeminiRequestBody(input))
      }
    );
    if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
    const body = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal: input.signal,
    body: JSON.stringify({ model: input.model, max_tokens: 200, temperature: 0, messages: [{ role: "user", content: input.prompt }] })
  });
  if (!response.ok) throw new Error(`Anthropic request failed: ${response.status}`);
  const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  return body.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
};
