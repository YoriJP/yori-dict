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

test("English resolve returns released data without calling a model", async () => {
  const entry = releasedEntry();
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  expect(await dictionary.resolve({ query: "BANK", targetDictionary: "en" })).toEqual(entry);
  expect(gateway.calls).toEqual([]);
});

test("English resolve completes and stages missing examples on released senses", async () => {
  const entry = releasedEntry();
  entry.senses[0].examples = [];
  const repository = new MemoryEnglishRepository({ released: [["bank", entry]] });
  const gateway = new ScriptedGateway([
    JSON.stringify({ sentence: "She deposited her salary at the bank." }),
    reviewAccepted
  ]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  const completed = await dictionary.resolve({ query: "bank", targetDictionary: "en" });
  expect(completed?.senses[0].examples).toEqual([{
    text: "She deposited her salary at the bank.", source: "generated", reviewStatus: "checked"
  }]);
  expect(repository.entry).toEqual(completed);
});

test("English resolve rejects obvious non-lexical candidates before model eligibility", async () => {
  const repository = new MemoryEnglishRepository();
  const gateway = new ScriptedGateway([]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  for (const query of ["https://example.com", "<b>word</b>", "123.45", "two\nlines", "東京"]) {
    expect(await dictionary.resolve({ query, targetDictionary: "en" })).toBeNull();
  }
  expect(gateway.calls).toEqual([]);
});

test("English resolve authors, reviews, stages, and completes source-grounded senses", async () => {
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
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  const entry = await dictionary.resolve({ query: "lead", targetDictionary: "en" });
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
    "openai/gpt-5.6-luna",
    "google/gemini-3-flash-preview",
    "openai/gpt-5.6-luna",
    "google/gemini-3-flash-preview"
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
    JSON.stringify({ candidateId: "wrong-id", issues: [] })
  ]);
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  const [first, second] = await Promise.all([
    dictionary.resolve({ query: "lead", targetDictionary: "en" }),
    dictionary.resolve({ query: "lead", targetDictionary: "en" })
  ]);
  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(repository.entry).toBeNull();
  expect(gateway.calls).toHaveLength(2);
  expect(repository.attempts.at(-1)?.outcome).toBe("malformed");
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
  const dictionary = createEnglishOnDemandDictionary({ repository, modelGateway: gateway });

  expect(await dictionary.resolve({ query: "florp", targetDictionary: "en" })).toBeNull();
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
  const entry = await createEnglishOnDemandDictionary({ repository, modelGateway: gateway })
    .resolve({ query: "florp", targetDictionary: "en" });

  expect(entry?.senses[0].generation).toMatchObject({
    model: "openai/gpt-5.6-luna",
    provider: "openrouter",
    promptVersion: "english-entry-author-v1",
    serviceTier: "standard"
  });
});

const reviewAccepted = (request: ModelRequest) => JSON.stringify({
  candidateId: request.prompt.match(/candidateId: ([^\n]+)/)?.[1],
  issues: []
});

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
      outputTokens: 10
    };
  }
}

class MemoryEnglishRepository implements EnglishEnrichmentRepository {
  entry: EnglishEntry | null = null;
  readonly attempts: AttemptRecord[] = [];
  private readonly released: Map<string, EnglishEntry>;
  private readonly sources: Map<string, EnglishSourceRecord[]>;
  private readonly terminal = new Map<string, string>();
  constructor(options: {
    released?: Array<[string, EnglishEntry]>;
    sources?: Array<[string, EnglishSourceRecord[]]>;
  } = {}) {
    this.released = new Map(options.released ?? []);
    this.sources = new Map(options.sources ?? []);
  }
  findReleased(query: string) { return this.released.get(query.toLowerCase()) ?? null; }
  findOverlay(query: string) { return this.entry?.headword === query.toLowerCase() ? this.entry : null; }
  findSources(query: string) { return structuredClone(this.sources.get(query.toLowerCase()) ?? []); }
  saveEntry(entry: EnglishEntry) { this.entry = structuredClone(entry); }
  saveExample(senseId: string, example: EnglishExample) {
    if (!this.entry) return;
    this.entry = { ...this.entry, senses: this.entry.senses.map((sense) =>
      sense.id === senseId ? { ...sense, examples: [example] } : sense
    ) };
  }
  recordAttempt(attempt: AttemptRecord) { this.attempts.push(attempt); }
  terminalOutcome(key: string) { return this.terminal.get(key) ?? null; }
  saveTerminalOutcome(key: string, outcome: string) { this.terminal.set(key, outcome); }
}

function sourceRecord(): EnglishSourceRecord {
  return {
    source: "wiktionary", sourceVersion: "2026-07-06", sourceEntryId: "en:lead:verb:1",
    license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later", attribution: "English Wiktionary contributors",
    rawRecord: { word: "lead" }, headword: "lead",
    pronunciations: [{ ipa: "/liːd/", region: "US", evidenceId: "wiktionary:en:lead:verb:1:pronunciation:1" }],
    senses: [{
      evidenceId: "wiktionary:en:lead:verb:1:1", partOfSpeech: "verb", definition: "to guide or conduct",
      registers: [], regions: [], domains: [], dated: false, usage: ["transitive"], examples: []
    }]
  };
}

function releasedEntry(): EnglishEntry {
  return {
    id: "yori:en:e_bank", dictionary: "en", headword: "bank", pronunciations: [], sources: [],
    senses: [{
      id: "yori:en:s_bank", position: 1, partOfSpeech: "noun", definition: "a financial institution",
      registers: [], regions: [], domains: ["finance"], dated: false, usage: [], examples: [{
        text: "The bank approved the loan.", source: "sourced", sourceId: "fixture:1", reviewStatus: "source"
      }],
      evidenceIds: ["open-english-wordnet:bank:1"], provenance: "source"
    }]
  };
}
