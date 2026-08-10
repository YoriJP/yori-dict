import { expect, test } from "bun:test";
import {
  createEnglishOnDemandDictionary,
  type AttemptRecord,
  type EnglishEnrichmentRepository,
  type ModelGateway,
  ModelGatewayError,
  type ModelRequest,
  type ModelResponse
} from "../src/on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "../src/english-types";
import type { ApiLang } from "../src/types";

const englishModels = { author: "test/english-author", reviewer: "test/english-reviewer" };

test("English resolve returns released data without calling a model", async () => {
  const entry = releasedEntry();
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  expect(await dictionary.resolve({ query: "BANK", targetDictionary: "en", lang: "en" })).toEqual(entry);
  expect(gateway.calls).toEqual([]);
});

test("English enrichment needs no configuration to run", () => {
  // English used to disable itself when two environment variables were unset,
  // which read from outside as "this word has no content". It is always on, and
  // revoking the OpenRouter key is what stops model work.
  expect(createEnglishOnDemandDictionary({
    repository: new MemoryEnglishRepository(),
    modelGateway: new ScriptedGateway([])
  })).toBeDefined();
});

test("English resolve completes missing examples on released senses", async () => {
  const entry = releasedEntry();
  entry.senses[0].examples = [];
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "She deposited her salary at the bank." }),
    reviewAccepted
  ]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  const completed = await dictionary.resolve({ query: "bank", targetDictionary: "en", lang: "en" });
  expect(completed?.senses[0].examples).toEqual([{
    text: "She deposited her salary at the bank.", source: "generated", reviewStatus: "checked"
  }]);
  // Only the missing example was written; the canonical entry was not rewritten.
  expect(repository.savedLangs).toEqual([]);
  expect(repository.savedExamples).toEqual([["yori:en:s_bank", {
    text: "She deposited her salary at the bank.", source: "generated", reviewStatus: "checked"
  }]]);
});

test("English translated groups require a matching example translation", async () => {
  const entry = releasedEntry();
  entry.senses[0].lang = "ja";
  entry.senses[0].examples = [{
    text: "The bank approved the loan.",
    source: "sourced",
    sourceId: "fixture:1",
    reviewStatus: "source"
  }];
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "The bank approved the loan.", translation: "銀行は融資を承認した。" }),
    reviewAccepted
  ]);

  const completed = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "bank", targetDictionary: "en", lang: "ja" });

  expect(completed?.senses[0].examples).toHaveLength(2);
  expect(completed?.senses[0].examples[1].translations).toEqual([
    { lang: "ja", text: "銀行は融資を承認した。" }
  ]);
});

test("English resolve returns released data when optional enrichment context is invalid", async () => {
  const entry = releasedEntry();
  entry.senses[0].lang = "ja";
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const dictionary = createEnglishOnDemandDictionary({
    repository,
    modelGateway: new ScriptedGateway([]),
    models: englishModels
  });

  const resolved = await dictionary.resolve({
    query: "bank",
    targetDictionary: "en",
    lang: "ja",
    context: { sentence: "https://invalid.example" }
  });

  expect(resolved).toEqual(entry);
});

test("English example enrichment retries one rejected candidate", async () => {
  const entry = releasedEntry();
  entry.senses[0].examples = [];
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "The bank approved the loan." }),
    "REJECT",
    JSON.stringify({ sentence: "She deposited her salary at the bank." }),
    reviewAccepted
  ]);

  const completed = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "bank", targetDictionary: "en", lang: "en" });

  expect(completed?.senses[0].examples[0].text).toBe("She deposited her salary at the bank.");
  expect(gateway.calls.map(({ role }) => role)).toEqual([
    "example-author", "example-review", "example-author", "example-review"
  ]);
});

test("generated English examples require a complete lexical match", async () => {
  const entry = releasedEntry();
  entry.headword = "art";
  entry.senses[0].examples = [];
  const repository = new MemoryEnglishRepository({ released: [["art", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "The party starts at eight." })
  ]);

  const completed = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "art", targetDictionary: "en", lang: "en" });
  expect(completed?.senses[0].examples).toEqual([]);
  expect(gateway.calls.map(({ role }) => role)).toEqual(["example-author", "example-author"]);
});

test("English resolve rejects obvious non-lexical candidates before model eligibility", async () => {
  const repository = new MemoryEnglishRepository();
  const gateway = new ScriptedGateway([]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  for (const query of ["https://example.com", "<b>word</b>", "123.45", "two\nlines", "東京"]) {
    expect(await dictionary.resolve({ query, targetDictionary: "en", lang: "en" })).toBeNull();
  }
  expect(gateway.calls).toEqual([]);
});

test("English resolve authors, reviews, persists, and completes source-grounded senses", async () => {
  const source = sourceRecord();
  const repository = new MemoryEnglishRepository({ sources: [["lead", [source]]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({
      headword: "lead",
      pronunciations: [{ ipa: "/liːd/", region: "US", evidenceIds: ["wiktionary:en:lead:verb:1:pronunciation:1"] }],
      senses: [{
        partOfSpeech: "verb",
        definition: "to guide or conduct",
        registers: [], regions: [], domains: [], dated: false, usage: ["transitive"],
        evidenceIds: ["wiktionary:en:lead:verb:1:1"], provenance: "source"
      }]
    }),
    reviewAccepted,
    JSON.stringify({ sentence: "She leads the design team." }),
    reviewAccepted
  ]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  const entry = await dictionary.resolve({ query: "lead", targetDictionary: "en", lang: "en" });
  expect(entry).toMatchObject({
    dictionary: "en",
    headword: "lead",
    senses: [{
      provenance: "source",
      evidenceIds: ["wiktionary:en:lead:verb:1:1"],
      examples: [{ text: "She leads the design team.", source: "generated", reviewStatus: "checked" }]
    }]
  });
  expect(repository.entry).toEqual(entry);
  expect(gateway.calls.map(({ role }) => role)).toEqual([
    "entry-author", "entry-review", "example-author", "example-review"
  ]);
  expect(gateway.calls.map(({ model }) => model)).toEqual([
    englishModels.author,
    englishModels.reviewer,
    englishModels.author,
    englishModels.reviewer
  ]);
});

test("English review fails closed and concurrent requests share one in-flight authoring run", async () => {
  const repository = new MemoryEnglishRepository({ sources: [["lead", [sourceRecord()]]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({
      headword: "lead", pronunciations: [{
        ipa: "/liːd/", region: "US", evidenceIds: ["wiktionary:en:lead:verb:1:pronunciation:1"]
      }],
      senses: [{
        partOfSpeech: "verb", definition: "invented sense", registers: [], regions: [], domains: [],
        dated: false, usage: ["transitive"], evidenceIds: ["wiktionary:en:lead:verb:1:1"], provenance: "source"
      }]
    }),
    "accept"
  ]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  const [first, second] = await Promise.all([
    dictionary.resolve({ query: "lead", targetDictionary: "en", lang: "en" }),
    dictionary.resolve({ query: "lead", targetDictionary: "en", lang: "en" })
  ]);
  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(repository.entry).toBeNull();
  expect(gateway.calls).toHaveLength(2);
  expect(repository.attempts.at(-1)?.outcome).toBe("malformed");
});

test("English source-backed senses cannot gain invented labels", async () => {
  const repository = new MemoryEnglishRepository({ sources: [["lead", [sourceRecord()]]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({
      headword: "lead",
      pronunciations: [{ ipa: "/liːd/", region: "US", evidenceIds: ["wiktionary:en:lead:verb:1:pronunciation:1"] }],
      senses: [{
        partOfSpeech: "verb", definition: "to guide or conduct", registers: ["formal"], regions: [], domains: [],
        dated: false, usage: ["transitive"], evidenceIds: ["wiktionary:en:lead:verb:1:1"], provenance: "source"
      }]
    })
  ]);

  const entry = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "lead", targetDictionary: "en", lang: "en" });
  expect(entry).toBeNull();
  expect(gateway.calls.map(({ role }) => role)).toEqual(["entry-author"]);
});

test("model work emits one aggregate outcome and cost summary", async () => {
  const entry = releasedEntry();
  entry.senses[0].examples = [];
  const summaries: Record<string, unknown>[] = [];
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "She deposited her salary at the bank." }),
    reviewAccepted
  ]);

  await createEnglishOnDemandDictionary({
    repository,
    modelGateway: gateway,
    models: englishModels,
    logger: (summary) => summaries.push(summary)
  }).resolve({ query: "bank", targetDictionary: "en", lang: "en", traceId: "trace-summary" });

  expect(summaries).toEqual([{
    event: "model_run_summary",
    traceId: "trace-summary",
    dictionary: "en",
    attempts: 2,
    outcomes: { candidate: 1, accepted: 1 },
    inputTokens: 20,
    outputTokens: 20,
    costUsd: 0.002
  }]);
});

test("English transient retries match the shared on-demand and bulk policy", async () => {
  const repository = new MemoryEnglishRepository();
  const gateway: ModelGateway & { calls: ModelRequest[] } = {
    calls: [],
    async call(request) {
      this.calls.push(request);
      if (this.calls.length < 2) throw new ModelGatewayError("transient", "try again");
      return {
        text: "SKIP", requestId: "request-2", model: request.model, provider: request.provider,
        effectiveServiceTier: request.requestedServiceTier, inputTokens: 1, outputTokens: 1
      };
    }
  };
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels });

  expect(await dictionary.resolve({ query: "florp", targetDictionary: "en", lang: "en" })).toBeNull();
  expect(gateway.calls.map(({ requestedServiceTier }) => requestedServiceTier)).toEqual(["flex", "standard"]);
  expect(repository.attempts.map(({ outcome }) => outcome)).toEqual(["transient", "skipped"]);
});

test("English generated provenance records the successful fallback tier", async () => {
  const repository = new MemoryEnglishRepository();
  const gateway: ModelGateway = {
    async call(request) {
      if (request.role === "eligibility") return response(request, "florp");
      if (request.role === "entry-author" && request.requestedServiceTier === "flex") {
        throw new ModelGatewayError("transient", "flex unavailable");
      }
      if (request.role === "entry-author") return response(request, JSON.stringify({
        headword: "florp", pronunciations: [], senses: [{
          partOfSpeech: "noun", definition: "a fictional test object", registers: [], regions: [], domains: [],
          dated: false, usage: [], evidenceIds: [], provenance: "generated"
        }]
      }));
      if (request.role === "example-author") return response(request, JSON.stringify({ sentence: "The florp is on the table." }));
      return response(request, reviewAccepted(request));
    }
  };
  const entry = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "florp", targetDictionary: "en", lang: "en" });

  expect(entry?.senses[0].generation).toMatchObject({
    model: englishModels.author,
    provider: "openrouter",
    promptVersion: "english-entry-author-v2",
    serviceTier: "standard"
  });
});

const reviewAccepted = (_request: ModelRequest) => "ACCEPT";

function response(request: ModelRequest, text: string): ModelResponse {
  return {
    text, requestId: `request-${request.role}-${request.requestedServiceTier}`, model: request.model,
    provider: request.provider, effectiveServiceTier: request.requestedServiceTier, inputTokens: 10, outputTokens: 10
  };
}

class ScriptedGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly responses: Array<string | ((request: ModelRequest) => string)>) {}
  async call(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected ${request.role} call`);
    return {
      text: typeof response === "function" ? response(request) : response,
      requestId: `request-${this.calls.length}`,
      model: request.model,
      provider: request.provider,
      effectiveServiceTier: request.requestedServiceTier,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.001
    };
  }
}

class MemoryEnglishRepository implements EnglishEnrichmentRepository {
  entry: EnglishEntry | null = null;

  labelVocabulary() {
    return { partOfSpeech: new Set(["noun", "verb", "adjective", "adverb"]) };
  }

  readonly attempts: AttemptRecord[] = [];
  readonly savedLangs: ApiLang[] = [];
  readonly savedExamples: Array<[string, EnglishExample]> = [];
  private readonly released: Map<string, EnglishEntry>;
  private readonly sources: Map<string, EnglishSourceRecord[]>;
  constructor(options: {
    released?: Array<[string, EnglishEntry]>;
    sources?: Array<[string, EnglishSourceRecord[]]>;
  } = {}) {
    this.released = new Map(options.released ?? []);
    this.sources = new Map(options.sources ?? []);
  }
  hasLookupTerm(term: string) {
    const normalized = term.toLowerCase();
    return this.released.has(normalized)
      || this.entry?.headword === normalized
      || this.sources.has(normalized);
  }
  find(query: string, lang: ApiLang) {
    const entry = this.entry?.headword === query.toLowerCase()
      ? this.entry
      : this.released.get(query.toLowerCase()) ?? null;
    if (!entry) return null;
    const senses = entry.senses.filter((sense) => sense.lang === lang);
    return senses.length > 0 ? { ...entry, senses } : null;
  }
  findAll(query: string, lang: ApiLang) {
    const entry = this.find(query, lang);
    return entry ? [entry] : [];
  }
  findSources(query: string) { return structuredClone(this.sources.get(query.toLowerCase()) ?? []); }
  saveEntry(entry: EnglishEntry, lang: ApiLang) {
    this.savedLangs.push(lang);
    this.entry = structuredClone(entry);
  }
  saveExample(senseId: string, example: EnglishExample) {
    this.savedExamples.push([senseId, example]);
    if (!this.entry) return;
    this.entry = { ...this.entry, senses: this.entry.senses.map((sense) =>
      sense.id === senseId ? { ...sense, examples: [example] } : sense
    ) };
  }
  recordAttempt(attempt: AttemptRecord) { this.attempts.push(attempt); }
}

function sourceRecord(): EnglishSourceRecord {
  return {
    source: "wiktionary", sourceVersion: "2026-07-06", sourceEntryId: "en:lead:verb:1",
    license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later", attribution: "English Wiktionary contributors",
    headword: "lead",
    pronunciations: [{ ipa: "/liːd/", region: "US", evidenceId: "wiktionary:en:lead:verb:1:pronunciation:1" }],
    senses: [{
      evidenceId: "wiktionary:en:lead:verb:1:1", partOfSpeech: "verb", glosses: ["to guide or conduct"],
      registers: [], regions: [], domains: [], dated: false, usage: ["transitive"], examples: []
    }]
  };
}

function releasedEntry(): EnglishEntry {
  return {
    id: "yori:en:e_bank", dictionary: "en", headword: "bank", pronunciations: [], sources: [],
    senses: [{
      id: "yori:en:s_bank", lang: "en", position: 1, partOfSpeech: "noun",
      glosses: [{ text: "a financial institution", source: "open-english-wordnet", reviewStatus: "source" }],
      registers: [], regions: [], domains: ["finance"], dated: false, usage: [], examples: [{
        text: "The bank approved the loan.", source: "sourced", sourceId: "fixture:1", reviewStatus: "source"
      }],
      evidenceIds: ["open-english-wordnet:bank:1"], provenance: "source"
    }]
  };
}

test("a new word first seen in an inflected form is still authored", async () => {
  // Relatedness reduces the query with the same stripper lookup uses. A
  // hand-rolled `+s`/`+es`/`+ed`/`+ing` set looks equivalent and is not: it
  // rejected `run` for `running`, so a word the dictionary has never seen,
  // first encountered in a doubled or y-changing form, could never be authored.
  const repository = new MemoryEnglishRepository();
  const gateway = new ScriptedGateway([
    "blog",
    JSON.stringify({
      headword: "blog",
      pronunciations: [],
      senses: [{
        partOfSpeech: "verb",
        definition: "to write an entry on a personal website",
        registers: [], regions: [], domains: [], dated: false, usage: [],
        provenance: "generated", evidenceIds: []
      }]
    }),
    reviewAccepted,
    JSON.stringify({ sentence: "She blogs about food every week." }),
    reviewAccepted
  ]);

  const resolved = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "blogging", targetDictionary: "en", lang: "en" });

  expect(resolved?.headword).toBe("blog");
  expect(repository.savedLangs).toEqual(["en"]);
});

test("an inflected English proposal becomes the lemma's entry, not a refusal", async () => {
  // `robot` is a published entry, so `robots` is one of its forms rather than
  // a second lexeme. Answering nothing would waste an entry we hold, and no
  // later enrichment could fix it: the next lookup reaches the same decision.
  const robot = releasedEntry();
  robot.headword = "robot";
  const repository = new MemoryEnglishRepository({ released: [["robot", robot]] });
  const gateway = new ScriptedGateway(["robots"]);

  const resolved = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "robots", targetDictionary: "en", lang: "en" });

  expect(resolved?.headword).toBe("robot");
  // The lemma was already complete, so no author or reviewer call was paid for
  // and no second entry was minted for the surface.
  expect(gateway.calls.map(({ role }) => role)).toEqual(["eligibility"]);
  expect(repository.savedLangs).toEqual([]);
});

test("an inflected proposal whose lemma lacks the language authors the lemma", async () => {
  // The lemma exists but carries no group in the requested language. That is a
  // real gap, so it is filled — for `robot`, never for the surface `robots`.
  const robot = releasedEntry();
  robot.headword = "robot";
  const repository = new MemoryEnglishRepository({ released: [["robot", robot]] });
  const gateway = new ScriptedGateway([
    "robots",
    JSON.stringify({
      headword: "robot",
      pronunciations: [],
      senses: [{
        partOfSpeech: "noun",
        definition: "機械で動く人型の装置",
        registers: [], regions: [], domains: [], dated: false, usage: [],
        provenance: "generated", evidenceIds: []
      }]
    }),
    reviewAccepted,
    JSON.stringify({ sentence: "その工場では robot が働いている。" }),
    reviewAccepted
  ]);

  const resolved = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "robots", targetDictionary: "en", lang: "ja" });

  expect(resolved?.headword).toBe("robot");
  expect(repository.savedLangs).toEqual(["ja"]);
});

test("an English headword that is a lexeme in its own right is still authored", async () => {
  // The guard must not swallow a real word that merely looks inflected. `bus`
  // strips to `bu`, which is not an entry, so authoring proceeds.
  const repository = new MemoryEnglishRepository();
  const gateway = new ScriptedGateway([
    "bus",
    JSON.stringify({
      headword: "bus",
      pronunciations: [],
      senses: [{
        partOfSpeech: "noun",
        definition: "a large road vehicle that carries many passengers",
        registers: [], regions: [], domains: [], dated: false, usage: [],
        provenance: "generated", evidenceIds: []
      }]
    }),
    reviewAccepted,
    JSON.stringify({ sentence: "She caught the bus to work." }),
    reviewAccepted
  ]);

  const resolved = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway, models: englishModels })
    .resolve({ query: "bus", targetDictionary: "en", lang: "en" });

  expect(resolved?.headword).toBe("bus");
  expect(repository.savedLangs).toEqual(["en"]);
});
