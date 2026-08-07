import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import { buildEnglishRelease } from "../src/english-release";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { importEnglishRelease, migrateProductionDatabase } from "../src/production-database";
import {
  createEnglishOnDemandDictionary,
  createJapaneseOnDemandDictionary,
  createOnDemandDictionary,
  ModelGatewayError,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from "../src/on-demand-dictionary";
import type { EnglishSourceRecord } from "../src/english-types";

/**
 * The lookup contract is verified at the HTTP seam over a temporary real
 * SQLite database. The model gateway is scripted: unless a test scripts a
 * response, any model call fails the test.
 */
class ScriptedGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  responses: string[] = [];
  failure: ModelGatewayError | null = null;

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    const text = this.responses.shift();
    if (text === undefined) throw new Error(`Unscripted ${request.role} model call`);
    return {
      text,
      requestId: `request-${this.calls.length}`,
      model: request.model,
      provider: "scripted",
      effectiveServiceTier: request.requestedServiceTier,
      inputTokens: 1,
      outputTokens: 1
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.responses = [];
    this.failure = null;
  }
}

const gateway = new ScriptedGateway();
let root: string;
let dbPath: string;
let lookupDb: LookupDb;
let closeRepositories: () => void;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "yori-lookup-contract-"));
  dbPath = join(root, "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --out ${dbPath}`.quiet();
  migrateProductionDatabase(dbPath);

  const writable = new Database(dbPath);
  writable
    .prepare("insert into glosses (sense_id, lang, text, source, review_status) values (?, 'zh-tw', ?, 'ai-assisted', 'checked')")
    .run("yori:s_jmdict_1358280_1", "吃");
  writable.close();

  const release = await buildEnglishRelease([englishSource()], {
    outputDirectory: join(root, "english"),
    version: "test",
    createdAt: "2026-08-06T00:00:00.000Z"
  });
  importEnglishRelease(dbPath, release.sqlite);

  lookupDb = openLookupDb(dbPath);
  const japaneseRepository = openEnrichmentRepository(dbPath, lookupDb);
  const englishRepository = openEnglishEnrichmentRepository(dbPath);
  closeRepositories = () => {
    japaneseRepository.close();
    englishRepository.close();
  };
  app = createApp(lookupDb, {
    enrichmentToken: "owner-token",
    englishLookup: (query) => englishRepository.find(query),
    onDemand: createOnDemandDictionary({
      japanese: createJapaneseOnDemandDictionary({ repository: japaneseRepository, modelGateway: gateway }),
      english: createEnglishOnDemandDictionary({
        repository: englishRepository,
        modelGateway: gateway,
        models: { author: "test/author", reviewer: "test/reviewer" }
      })
    })
  });
});

afterAll(() => {
  closeRepositories();
  lookupDb.close();
});

test("every lookup requires a supported dictionary and explanation language", async () => {
  gateway.reset();
  const cases = [
    "/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&lang=en",
    "/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja",
    "/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=fr&lang=en",
    "/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=fr",
    "/v1/lookup?q=bank&dictionary=en&lang=zh-tw",
    "/v1/lookup?dictionary=ja&lang=en"
  ];
  for (const path of cases) {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  }

  for (const body of [
    { lang: "en", queries: ["食べる"] },
    { dictionary: "ja", queries: ["食べる"] },
    { dictionary: "en", lang: "ko", queries: ["bank"] },
    { dictionary: "ja", lang: "en", queries: [] }
  ]) {
    const response = await app.request("/v1/lookup/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(400);
  }
  expect(gateway.calls).toEqual([]);
});

test("Japanese and English lookup share one base entry shape with their own extras", async () => {
  gateway.reset();
  const japanese = await (await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=en")).json();
  const english = await (await app.request("/v1/lookup?q=bank&dictionary=en&lang=en")).json();

  for (const entry of [japanese, english]) {
    expect(Object.keys(entry)).toEqual(expect.arrayContaining([
      "id", "dictionary", "lang", "headword", "headwords", "meanings", "sources"
    ]));
    expect(structuredClone(entry.meanings[0])).toMatchObject({
      id: expect.any(String),
      position: 1,
      partOfSpeech: expect.any(Array),
      glosses: expect.any(Array),
      examples: expect.any(Array),
      sources: expect.any(Array)
    });
  }
  expect(japanese.reading).toBe("たべる");
  expect(japanese).not.toHaveProperty("pronunciations");
  expect(english.pronunciations).toEqual([{ ipa: "/bæŋk/" }]);
  expect(english.meanings[0].glosses[0].text).toBe("a financial institution");
  expect(english.sources).toEqual(["open-english-wordnet:oewn-bank"]);
  expect(gateway.calls).toEqual([]);
});

test("lookup returns only the requested language and never falls back", async () => {
  gateway.reset();
  const taiwanese = await (await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=zh-tw")).json();
  expect(taiwanese.meanings.flatMap((meaning: { glosses: Array<{ text: string }> }) =>
    meaning.glosses.map(({ text }) => text)
  )).toEqual(["吃"]);

  const korean = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=ko");
  expect(korean.status).toBe(200);
  expect(await korean.json()).toBeNull();
  expect(gateway.calls).toEqual([]);
});

test("batch keeps input order and cardinality for duplicates and misses", async () => {
  gateway.reset();
  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dictionary: "ja",
      lang: "en",
      queries: ["食べる", "存在しない語", "食べる", "読む"]
    })
  });
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["entries"]);
  expect(body.entries).toHaveLength(4);
  expect(body.entries.map((entry: { headword: string } | null) => entry?.headword ?? null)).toEqual([
    "食べる", null, "食べる", "読む"
  ]);
  expect(JSON.stringify(body)).not.toContain("存在しない語");
  expect(gateway.calls).toEqual([]);
});

test("public lookup makes no model call, including on a miss", async () => {
  gateway.reset();
  const single = await app.request("/v1/lookup?q=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84%E8%AA%9E&dictionary=ja&lang=en");
  expect(single.status).toBe(200);
  expect(await single.json()).toBeNull();

  const english = await app.request("/v1/lookup?q=florp&dictionary=en&lang=en");
  expect(await english.json()).toBeNull();

  const batch = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dictionary: "en", lang: "en", queries: ["florp", "bank"] })
  });
  expect((await batch.json()).entries.map((entry: unknown) => entry === null)).toEqual([true, false]);
  expect(gateway.calls).toEqual([]);
});

test("enrichment requires the owner token before any model call", async () => {
  gateway.reset();
  const unauthorized = await app.request("/v1/lookup?q=florp&dictionary=en&lang=en&enrich=true");
  expect(unauthorized.status).toBe(401);

  const wrongToken = await app.request("/v1/lookup?q=florp&dictionary=en&lang=en&enrich=true", {
    headers: { authorization: "Bearer guess" }
  });
  expect(wrongToken.status).toBe(401);

  const tokenWithoutEnrich = await app.request("/v1/lookup?q=florp&dictionary=en&lang=en", {
    headers: { authorization: "Bearer owner-token" }
  });
  expect(tokenWithoutEnrich.status).toBe(200);
  expect(gateway.calls).toEqual([]);

  gateway.responses = ["SKIP"];
  const authorized = await app.request("/v1/lookup?q=florp&dictionary=en&lang=en&enrich=true", {
    headers: { authorization: "Bearer owner-token" }
  });
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toBeNull();
  expect(gateway.calls.map(({ role }) => role)).toEqual(["eligibility"]);
});

test("a provider failure is an operational error rather than a dictionary miss", async () => {
  gateway.reset();
  gateway.failure = new ModelGatewayError("authentication", "bad key");
  const single = await app.request("/v1/lookup?q=blorp&dictionary=en&lang=en&enrich=true", {
    headers: { authorization: "Bearer owner-token" }
  });
  expect(single.status).toBe(500);
  expect(await single.json()).toEqual({ error: "Lookup is temporarily unavailable" });

  const batch = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-token" },
    body: JSON.stringify({ dictionary: "en", lang: "en", enrich: true, queries: ["bank", "blorp"] })
  });
  expect(batch.status).toBe(500);
  gateway.reset();
});

test("a failed database read is an error, not a null entry", async () => {
  const failing = createApp({
    lookup() { throw new Error("database is locked"); },
    meta() { return { apiVersion: "v1", dictionaryVersion: null, languages: [], tags: {}, sources: [] }; },
    close() {}
  });
  const response = await failing.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=en");
  expect(response.status).toBe(500);
});

function englishSource(): EnglishSourceRecord {
  return {
    source: "open-english-wordnet",
    sourceVersion: "2024",
    sourceEntryId: "oewn-bank",
    license: "CC-BY-4.0",
    attribution: "Open English WordNet",
    rawRecord: { untouched: "oewn" },
    headword: "bank",
    pronunciations: [{ ipa: "/bæŋk/", evidenceId: "open-english-wordnet:oewn-bank:pronunciation:1" }],
    senses: [{
      evidenceId: "open-english-wordnet:oewn-bank:1",
      partOfSpeech: "noun",
      definition: "a financial institution",
      registers: [],
      regions: [],
      domains: ["finance"],
      dated: false,
      usage: [],
      examples: []
    }]
  };
}
