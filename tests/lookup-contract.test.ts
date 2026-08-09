import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import { rebuildEnglishDictionary, type EnglishSourceInput } from "../src/english-rebuild";
import { createStoredZip } from "../src/stored-zip";
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

  // Legacy accepted Taiwanese content maps onto an exact imported sense and
  // becomes that language's own independent sense.
  const writable = new Database(dbPath);
  const imported = writable
    .query<Record<string, unknown>, [string]>("select * from ja_senses where id = ?")
    .get("yori:s_jmdict_1358280_1:en")!;
  const taiwanese: Record<string, unknown> = {
    ...imported,
    id: "yori:s_jmdict_1358280_1:zh-tw",
    lang: "zh-tw",
    position: 1,
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: "yori:s_jmdict_1358280_1"
  };
  const columns = Object.keys(taiwanese);
  writable
    .prepare(`insert into ja_senses (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => taiwanese[column] as never));
  writable
    .prepare("insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, ?, 'generated', 'checked')")
    .run("yori:s_jmdict_1358280_1:zh-tw", "吃");
  writable.close();

  const english = await rebuildEnglishDictionary({
    sources: [await englishSource(root)],
    out: join(root, "english.sqlite"),
    version: "test",
    retainFrom: null
  });
  importEnglishRelease(dbPath, english.path);

  lookupDb = openLookupDb(dbPath);
  const japaneseRepository = openEnrichmentRepository(dbPath, lookupDb);
  const englishRepository = openEnglishEnrichmentRepository(dbPath);
  closeRepositories = () => {
    japaneseRepository.close();
    englishRepository.close();
  };
  app = createApp(lookupDb, {
    enrichmentToken: "owner-token",
    englishLookup: (query, lang) => englishRepository.find(query, lang),
    englishMeta: () => englishRepository.meta(),
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
    "/v1/lookup?q=bank&dictionary=en&lang=de",
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

test("metadata advertises only explanation languages with senses behind them", async () => {
  gateway.reset();
  const meta = await (await app.request("/v1/meta")).json();

  // Each dictionary reports its own languages, derived from its own rows.
  // This database holds English and legacy Taiwanese Japanese senses and an
  // English-explained English dictionary, and nothing else.
  // `accepts` is the contract and does not move; `languages` is observed and
  // does. A consumer choosing which locales to offer reads `accepts`, because
  // a language absent from `languages` is a coverage gap Enrich-on-Lookup can
  // fill, not a language the API will refuse.
  expect(meta.dictionaries).toEqual({
    ja: { languages: ["en", "zh-tw"], accepts: ["en", "de", "zh-tw", "zh-cn", "ko"] },
    en: { languages: ["en"], accepts: ["en", "ja", "zh-tw"] }
  });

  // A supported language with no rows behind it is not advertised, so a
  // consumer generating one artifact per pair skips it instead of emitting an
  // empty file. It is still a valid request that Enrich-on-Lookup can fill.
  for (const dictionary of ["ja", "en"] as const) {
    for (const lang of meta.dictionaries[dictionary].languages) {
      const response = await app.request(
        `/v1/lookup?q=${dictionary === "ja" ? "%E9%A3%9F%E3%81%B9%E3%82%8B" : "bank"}&dictionary=${dictionary}&lang=${lang}`
      );
      expect(await response.json()).not.toBeNull();
    }
  }
  expect(meta.dictionaries.ja.languages).not.toContain("de");

  // Every source the served data draws on is credited once, with a license and
  // a URL a reader can follow to satisfy the obligation they inherit.
  const sources = meta.sources as Array<{ name: string; license: string; url: string }>;
  expect(sources.map(({ name }) => name)).toContain("JMdict");
  expect(sources.map(({ name }) => name)).toContain("Open English WordNet");
  expect(new Set(sources.map(({ name }) => name)).size).toBe(sources.length);
  for (const source of sources) {
    expect(source.license).not.toBe("");
    expect(source.url).toMatch(/^https:\/\//);
  }
  expect(gateway.calls).toEqual([]);
});

test("an inflected English surface returns the lemma's entry, not a stub", async () => {
  gateway.reset();
  const lemma = await (await app.request("/v1/lookup?q=bank&dictionary=en&lang=en")).json();
  const inflected = await (await app.request("/v1/lookup?q=banks&dictionary=en&lang=en")).json();

  // A client sends the word as it appeared in the text. It gets the lexeme's
  // entry, titled with the lemma, with the lemma's complete sense list.
  expect(inflected).not.toBeNull();
  expect(inflected.headword).toBe("bank");
  expect(inflected.id).toBe(lemma.id);
  expect(inflected.senses).toEqual(lemma.senses);
  // No field carries the surface back: the caller already holds the occurrence
  // it sent, and `query != headword` is what says resolution happened.
  expect(Object.keys(inflected)).toEqual(Object.keys(lemma));
  // Resolution is silent. English gains no inflection path; the concept stays
  // Japanese-only, where the derivation is what the learner needs to see.
  expect(inflected).not.toHaveProperty("inflectionPath");
  // Resolving never happens for a word that is itself an entry.
  expect(lemma.headword).toBe("bank");
  expect(gateway.calls).toEqual([]);
});

test("a supported language with no content is answered, not refused", async () => {
  gateway.reset();
  // German's JMdict component is unlicensed and is not imported, but `de` is
  // still an explanation language the Japanese dictionary answers in. An
  // unauthenticated miss is null; the language itself is not a request error.
  const german = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=de");
  expect(german.status).toBe(200);
  expect(await german.json()).toBeNull();
  expect(gateway.calls).toEqual([]);
});

test("Japanese and English lookup share one base entry shape with their own extras", async () => {
  gateway.reset();
  const japanese = await (await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=en")).json();
  const english = await (await app.request("/v1/lookup?q=bank&dictionary=en&lang=en")).json();

  for (const entry of [japanese, english]) {
    expect(Object.keys(entry)).toEqual(expect.arrayContaining([
      "id", "dictionary", "lang", "headword", "headwords", "senses", "sources"
    ]));
    expect(structuredClone(entry.senses[0])).toMatchObject({
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
  expect(english.senses[0].glosses[0].text).toBe("a financial institution");
  expect(english.sources).toEqual(["open-english-wordnet:bank:n"]);
  expect(gateway.calls).toEqual([]);
});

test("lookup returns only the requested language and never falls back", async () => {
  gateway.reset();
  const taiwanese = await (await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=zh-tw")).json();
  expect(taiwanese.senses.flatMap((sense: { glosses: Array<{ text: string }> }) =>
    sense.glosses.map(({ text }) => text)
  )).toEqual(["吃"]);

  const korean = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&dictionary=ja&lang=ko");
  expect(korean.status).toBe(200);
  expect(await korean.json()).toBeNull();

  // English accepts Japanese and Taiwanese Chinese as explanation languages.
  // A headword with no group in one of them is a miss for that language, never
  // the English group under another language's name.
  for (const lang of ["ja", "zh-tw"]) {
    const response = await app.request(`/v1/lookup?q=bank&dictionary=en&lang=${lang}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  }
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

  // A batch is answered word by word. One provider failure is reported as a
  // miss for its own query and does not discard the entries beside it, because
  // a consumer sending a page of text should not lose the page to one word.
  const batch = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-token" },
    body: JSON.stringify({ dictionary: "en", lang: "en", enrich: true, queries: ["bank", "blorp"] })
  });
  expect(batch.status).toBe(200);
  const { entries } = await batch.json();
  expect(entries[0]?.headword).toBe("bank");
  expect(entries[1]).toBeNull();

  // A batch where nothing at all came back is the other thing: a bad key, a
  // dead provider. Answering it with a full set of misses would let a consumer
  // publish an empty dictionary and believe it, so that one still fails.
  const allFailed = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-token" },
    body: JSON.stringify({ dictionary: "en", lang: "en", enrich: true, queries: ["blorp", "blorpier"] })
  });
  expect(allFailed.status).toBe(500);
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

async function englishSource(directory: string): Promise<EnglishSourceInput> {
  const file = join(directory, "wordnet.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        bank: {
          n: { pronunciation: [{ value: "/b\u00e6\u014bk/" }], sense: [{ id: "bank%1:14:00::", synset: "s-finance" }] }
        }
      })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "s-finance": {
          definition: ["a financial institution"],
          domain_topic: ["s-domain-finance"],
          members: ["bank"],
          partOfSpeech: "n"
        },
        "s-domain-finance": { definition: ["the business of banking"], members: ["finance"], partOfSpeech: "n" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2024", file };
}
