import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { migrateProductionDatabase } from "../src/production-database";
import { createJapaneseOnDemandDictionary, createOnDemandDictionary, ModelGatewayError } from "../src/on-demand-dictionary";
import type {
  EnglishOnDemandDictionary,
  JapaneseOnDemandDictionary,
  OnDemandDictionary,
  ResolveRequest
} from "../src/on-demand-dictionary";
import type { ModelRequest } from "../src/on-demand-dictionary";
import type { EnglishEntry } from "../src/english-types";
import type { PublicLookupItem } from "../src/types";

test("public lookup stays model-free while authenticated enrichment delegates through resolve", async () => {
  const calls: ResolveRequest[] = [];
  const generated = generatedEntry();
  const onDemand: JapaneseOnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return generated;
    }
  };
  const app = createApp(emptyDb(), { onDemand: japaneseResolver(onDemand), enrichmentToken: "secret" });

  expect((await app.request("/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E&dictionary=ja&lang=en")).status).toBe(200);
  expect(calls).toHaveLength(0);
  expect((await app.request("/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E&dictionary=ja&lang=en&enrich=true")).status).toBe(401);
  expect(calls).toHaveLength(0);

  const response = await app.request(
    "/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E&dictionary=ja&lang=en&enrich=true&lemma=%E6%9C%AA%E7%9F%A5%E8%AA%9E&reading=%E3%81%BF%E3%81%A1%E3%81%94&context=%E6%9C%AA%E7%9F%A5%E8%AA%9E%E3%82%92%E8%AA%BF%E3%81%B9%E3%81%9F%E3%80%82",
    { headers: { authorization: "Bearer secret" } }
  );
  expect(response.status).toBe(200);
  const entry = await response.json();
  expect(entry.headword).toBe("未知語");
  expect(entry.senses[0].glosses).toEqual([
    { text: "unknown term", source: "generated", reviewStatus: "checked" }
  ]);
  expect(calls).toEqual([
    {
      query: "未知語",
      targetDictionary: "ja",
      lang: "en",
      traceId: expect.any(String),
      context: { lemma: "未知語", reading: "みちご", sentence: "未知語を調べた。" }
    }
  ]);
});

test("the requested explanation language reaches the internal resolve request", async () => {
  const calls: ResolveRequest[] = [];
  const onDemand: JapaneseOnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return null;
    }
  };
  const app = createApp(emptyDb(), { onDemand: japaneseResolver(onDemand), enrichmentToken: "secret" });

  await app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1&dictionary=ja&lang=zh-tw&enrich=true", {
    headers: { authorization: "Bearer secret" }
  });
  await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ dictionary: "ja", lang: "ko", enrich: true, queries: ["学校"] })
  });

  expect(calls.map(({ lang }) => lang)).toEqual(["zh-tw", "ko"]);
});

test("the lookup route keeps a proven-partial group model-free until authorized repair", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-route-partial-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${path}`.quiet();
  migrateProductionDatabase(path);
  const db = new Database(path);
  const entryId = "yori:e_jmdict_1206730";
  const englishSenseId = "yori:s_jmdict_1206730_1:en";
  const targetSenseId = "yori:s_jmdict_1206730_1:zh-tw";
  db.prepare(`
    insert into ja_sense_evidence (sense_id, position, evidence_id, source_name)
    values (?, 2, 'jmdict:1206730:2', 'jmdict')
  `).run(englishSenseId);
  const source = db.query<Record<string, unknown>, [string]>("select * from ja_senses where id = ?")
    .get(englishSenseId)!;
  const target: Record<string, unknown> = {
    ...source,
    id: targetSenseId,
    lang: "zh-tw",
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: "jmdict:1206730:1",
    generation_id: "legacy:route"
  };
  db.prepare(`
    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values ('legacy:route', 'legacy', 'unrecorded', 'unrecorded', 'legacy', null, 'accepted', 'legacy')
  `).run();
  const columns = Object.keys(target);
  db.prepare(`insert into ja_senses (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => target[column] as never));
  db.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, '舊的學校解釋', 'generated', 'checked')"
  ).run(targetSenseId);
  db.prepare(
    "insert into ja_sense_evidence (sense_id, position, evidence_id, source_name) values (?, 1, 'jmdict:1206730:1', 'yori-legacy')"
  ).run(targetSenseId);
  db.prepare(`
    insert into ja_explanation_group_gaps
      (entry_id, lang, missing_evidence_id, source_version, basis)
    values (?, 'zh-tw', 'jmdict:1206730:2', 'fixture', 'legacy-exact-sense-mapping')
  `).run(entryId);
  db.close();

  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const responses = [
    JSON.stringify({
      headword: "学校", reading: "がっこう",
      senses: [{
        partOfSpeech: ["n"], registers: [], domains: [], dialect: [], pronunciations: [],
        pragmaticFunctions: [], glosses: ["提供教育的機構"],
        evidenceIds: ["jmdict:1206730:1", "jmdict:1206730:2"], provenance: "source"
      }]
    }),
    "ACCEPT", "ACCEPT",
    JSON.stringify({ sentence: "毎朝、学校へ行きます。", translation: "我每天早上去學校。" }),
    "ACCEPT", "ACCEPT"
  ];
  const calls: ModelRequest[] = [];
  const dictionary = createJapaneseOnDemandDictionary({
    repository,
    reviewPasses: 2,
    modelGateway: {
      async call(input) {
        calls.push(input);
        const text = responses.shift();
        if (!text) throw new Error(`Unexpected ${input.role} call`);
        return {
          text, requestId: `request-${calls.length}`, model: input.model, provider: "scripted",
          effectiveServiceTier: input.requestedServiceTier, inputTokens: 1, outputTokens: 1
        };
      }
    }
  });
  const app = createApp(lookup, { onDemand: japaneseResolver(dictionary), enrichmentToken: "secret" });

  const publicResponse = await app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1&dictionary=ja&lang=zh-tw");
  expect((await publicResponse.json()).senses[0].glosses[0].text).toBe("舊的學校解釋");
  expect(calls).toHaveLength(0);

  const failingDictionary = createJapaneseOnDemandDictionary({
    repository,
    reviewPasses: 2,
    modelGateway: {
      async call() {
        throw new ModelGatewayError("permanent", "provider unavailable");
      }
    }
  });
  const failingApp = createApp(lookup, {
    onDemand: japaneseResolver(failingDictionary),
    enrichmentToken: "secret"
  });
  const degraded = await failingApp.request(
    "/v1/lookup?q=%E5%AD%A6%E6%A0%A1&dictionary=ja&lang=zh-tw&enrich=true",
    { headers: { authorization: "Bearer secret" } }
  );
  expect(degraded.status).toBe(200);
  expect((await degraded.json()).senses[0].glosses[0].text).toBe("舊的學校解釋");
  const retryable = new Database(path, { readonly: true });
  expect(retryable.query<{ count: number }, []>(
    "select count(*) as count from ja_explanation_group_gaps where entry_id = 'yori:e_jmdict_1206730' and lang = 'zh-tw'"
  ).get()?.count).toBe(1);
  retryable.close();

  const enrichedRequests = await Promise.all([1, 2].map(() => app.request(
    "/v1/lookup?q=%E5%AD%A6%E6%A0%A1&dictionary=ja&lang=zh-tw&enrich=true",
    { headers: { authorization: "Bearer secret" } }
  )));
  expect(enrichedRequests.map(({ status }) => status)).toEqual([200, 200]);
  for (const response of enrichedRequests) {
    expect((await response.json()).senses[0].glosses[0].text).toBe("提供教育的機構");
  }
  expect(calls.map(({ role }) => role)).toEqual([
    "entry-author", "entry-review", "entry-review", "example-author", "example-review", "example-review"
  ]);
  repository.close();
  lookup.close();
});

test("batch enrichment accepts contextual candidates while preserving order", async () => {
  const calls: ResolveRequest[] = [];
  const onDemand: JapaneseOnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return generatedEntry();
    }
  };
  const app = createApp(emptyDb(), { onDemand: japaneseResolver(onDemand), enrichmentToken: "secret" });
  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({
      dictionary: "ja",
      lang: "en",
      enrich: true,
      queries: [
        "未知語",
        { query: "取り組んで", lemma: "取り組む", reading: "とりくむ", context: "改革に取り組んでいる。" }
      ]
    })
  });

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    { query: "未知語", targetDictionary: "ja", lang: "en", mode: "bulk", traceId: expect.any(String) },
    {
      query: "取り組んで",
      targetDictionary: "ja",
      lang: "en",
      mode: "bulk",
      traceId: expect.any(String),
      context: { lemma: "取り組む", reading: "とりくむ", sentence: "改革に取り組んでいる。" }
    }
  ]);
  expect(calls[1].traceId).toBe(calls[0].traceId);
  const { entries } = await response.json();
  expect(entries).toHaveLength(2);
  expect(entries.map((entry: { headword: string }) => entry.headword)).toEqual(["未知語", "未知語"]);
});

test("a healthy enriched batch starts every query before any query finishes", async () => {
  let started = 0;
  let firstStarted!: () => void;
  let release!: () => void;
  const observedFirst = new Promise<void>((resolve) => { firstStarted = resolve; });
  const allMayFinish = new Promise<void>((resolve) => { release = resolve; });
  const onDemand: JapaneseOnDemandDictionary = {
    async resolve() {
      started += 1;
      firstStarted();
      await allMayFinish;
      return generatedEntry();
    }
  };
  const app = createApp(emptyDb(), { onDemand: japaneseResolver(onDemand), enrichmentToken: "secret" });
  const response = app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ dictionary: "ja", lang: "en", enrich: true, queries: ["一", "二", "三", "四"] })
  });

  await observedFirst;
  await Bun.sleep(0);
  const startedBeforeAnyFinished = started;
  release();
  expect((await response).status).toBe(200);
  expect(startedBeforeAnyFinished).toBe(4);
});

test("one failed word is a miss and the rest of the batch survives", async () => {
  const events: Record<string, unknown>[] = [];
  const released = generatedEntry();
  released.source = "jmdict";
  const db = emptyDb();
  db.lookup = () => ({ item: released, alternatives: [] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    logger: (event) => events.push(event as Record<string, unknown>),
    onDemand: {
      async resolve(request) {
        if (request.query === "壊れた語") throw new ModelGatewayError("permanent", "provider unavailable");
        return null;
      }
    }
  });

  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ dictionary: "ja", lang: "en", enrich: true, queries: ["学校", "壊れた語", "学校"] })
  });

  expect(response.status).toBe(200);
  const { entries } = await response.json();
  expect(entries).toHaveLength(3);
  expect(entries[0]?.headword).toBe("未知語");
  expect(entries[1]).toBeNull();
  expect(entries[2]?.headword).toBe("未知語");
  expect(events.filter((event) => event.event === "lookup_failed")).toEqual([
    {
      event: "lookup_failed",
      traceId: expect.any(String),
      dictionary: "ja",
      lang: "en",
      query: "壊れた語",
      error: "provider unavailable"
    }
  ]);
});

test("an enriched hit on a released word keeps the siblings that word reached", async () => {
  // `resolve` returns the released entry unchanged when it is already
  // complete, so an authored entry is not evidence that the query was a miss.
  // Treating it as one dropped alternatives for exactly the enriched path
  // yori-news and yori-web use.
  const released = generatedEntry();
  released.source = "jmdict";
  const sibling = { ...generatedEntry(), id: "yori:e_sibling", word: "琴" };
  const db = emptyDb();
  db.lookup = () => ({ item: released, alternatives: [sibling] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    // The completed copy of the same entry, by id.
    onDemand: { async resolve() { return released; } }
  });

  const response = await app.request("/v1/lookup?q=%E3%81%93%E3%81%A8&dictionary=ja&lang=en&enrich=true", {
    headers: { authorization: "Bearer secret" }
  });
  const entry = await response.json();
  expect(entry.id).toBe(released.id);
  // The sibling survives, and the completed entry does not become an
  // alternative to itself.
  expect(entry.alternatives).toHaveLength(1);
  expect(entry.alternatives[0].id).toBe("yori:e_sibling");
});

test("enriched alternatives replace their released copies without changing rank", async () => {
  const primary = generatedEntry();
  primary.id = "yori:e_primary";
  primary.source = "jmdict";
  const sibling = { ...generatedEntry(), id: "yori:e_sibling", word: "琴" };
  const enrichedSibling = structuredClone(sibling);
  enrichedSibling.senses[0].examples = [{
    text: "琴を弾きます。",
    translations: [{ lang: "en", text: "I play the koto." }],
    source: "generated",
    reviewStatus: "checked"
  }];
  const db = emptyDb();
  db.lookup = () => ({ item: primary, alternatives: [sibling] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    onDemand: {
      async resolve() { return primary; },
      async resolveAll() { return { item: primary, alternatives: [enrichedSibling], ranked: true }; }
    }
  });

  const response = await app.request("/v1/lookup?q=%E3%81%93%E3%81%A8&dictionary=ja&lang=en&enrich=true", {
    headers: { authorization: "Bearer secret" }
  });
  const entry = await response.json();
  expect(entry.id).toBe(primary.id);
  expect(entry.alternatives).toHaveLength(1);
  expect(entry.alternatives[0].id).toBe(sibling.id);
  expect(entry.alternatives[0].senses[0].examples[0].translations[0].text).toBe("I play the koto.");
});

test("a failed primary is not replaced by a successfully enriched alternative", async () => {
  const sibling = { ...generatedEntry(), id: "yori:e_sibling", word: "琴" };
  const db = emptyDb();
  db.lookup = () => ({ item: sibling, alternatives: [] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    onDemand: {
      async resolve() { return null; },
      async resolveAll() { return { item: null, alternatives: [sibling], ranked: true }; }
    }
  });

  const response = await app.request("/v1/lookup?q=%E3%81%93%E3%81%A8&dictionary=ja&lang=en&enrich=true", {
    headers: { authorization: "Bearer secret" }
  });
  expect(await response.json()).toBeNull();
});

test("a storage failure inside resolve fails the batch, unlike a provider failure", async () => {
  // `resolve` writes attempt records and accepted entries as it goes, so a
  // locked database throws from inside it just as a dead provider does.
  // Narrowing which call is wrapped cannot separate them; only the error type
  // can. A word that reached no provider is not a word the dictionary lacks.
  const released = generatedEntry();
  released.source = "jmdict";
  const db = emptyDb();
  db.lookup = () => ({ item: released, alternatives: [] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    onDemand: {
      async resolve(request) {
        if (request.query === "壊れた語") throw new Error("database is locked");
        return null;
      }
    }
  });

  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ dictionary: "ja", lang: "en", enrich: true, queries: ["学校", "壊れた語"] })
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Lookup is temporarily unavailable" });
});

test("a storage failure fails the batch instead of reporting the word as missing", async () => {
  // The same rule for a read: an unreadable row is this server's own problem,
  // and reporting it as a gap would let a consumer record one that never
  // existed.
  const released = generatedEntry();
  released.source = "jmdict";
  const db = emptyDb();
  db.lookup = (query: string) => {
    if (query === "壊れた行") throw new Error("malformed stored entry");
    return { item: released, alternatives: [] };
  };
  const app = createApp(db, { enrichmentToken: "secret" });

  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dictionary: "ja", lang: "en", queries: ["学校", "壊れた行"] })
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Lookup is temporarily unavailable" });
});

test("a batch where every word failed fails the request instead of reporting misses", async () => {
  const released = generatedEntry();
  released.source = "jmdict";
  const db = emptyDb();
  db.lookup = () => ({ item: released, alternatives: [] });
  const app = createApp(db, {
    enrichmentToken: "secret",
    onDemand: { async resolve() { throw new ModelGatewayError("permanent", "provider unavailable"); } }
  });

  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ dictionary: "ja", lang: "en", enrich: true, queries: ["学校"] })
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Lookup is temporarily unavailable" });
});

test("English batch lookup uses the independent dictionary and authenticated resolver", async () => {
  const calls: ResolveRequest[] = [];
  const events: Record<string, unknown>[] = [];
  const lookupQueries: string[] = [];
  const entry = englishEntry();
  const englishOnDemand: EnglishOnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return entry;
    }
  };
  const app = createApp(emptyDb(), {
    enrichmentToken: "secret",
    englishLookupAll: (query: string) => {
      lookupQueries.push(query);
      return ["bank", "news"].includes(query.toLowerCase()) ? [entry] : [];
    },
    onDemand: englishResolver(englishOnDemand),
    logger: (event) => events.push(event)
  });

  const publicResponse = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-yori-request-id": "news-request-1" },
    body: JSON.stringify({
      dictionary: "en",
      lang: "en",
      queries: [{ query: "banks", lemma: "bank", context: "Several banks closed." }]
    })
  });
  expect(publicResponse.status).toBe(200);
  expect((await publicResponse.json()).entries[0]).toMatchObject({
    id: entry.id,
    dictionary: "en",
    lang: "en",
    headword: "bank"
  });
  expect(calls).toHaveLength(0);
  expect(events[0]).toMatchObject({
    event: "dictionary_lookup",
    traceId: "news-request-1",
    dictionary: "en",
    lang: "en",
    query: "banks",
    enrichmentRequested: false,
    outcome: "resolved",
    entryId: entry.id
  });

  const surfaceFirst = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dictionary: "en",
      lang: "en",
      queries: [{ query: "news", lemma: "new", context: "News travels quickly." }]
    })
  });
  expect((await surfaceFirst.json()).entries[0].headword).toBe("bank");
  expect(lookupQueries.slice(-1)).toEqual(["news"]);

  const unauthorized = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dictionary: "en", lang: "en", enrich: true, queries: ["florp"] })
  });
  expect(unauthorized.status).toBe(401);
  expect(calls).toHaveLength(0);

  const enriched = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      "x-yori-request-id": "news-request-2"
    },
    body: JSON.stringify({
      dictionary: "en",
      lang: "en",
      enrich: true,
      queries: [{ query: "florp", lemma: "florp", context: "The florp moved quickly." }]
    })
  });
  expect(enriched.status).toBe(200);
  expect((await enriched.json()).entries[0].headword).toBe("bank");
  expect(calls).toEqual([{
    query: "florp",
    targetDictionary: "en",
    lang: "en",
    mode: "bulk",
    traceId: "news-request-2",
    context: { lemma: "florp", sentence: "The florp moved quickly." }
  }]);
});

function japaneseResolver(japanese: JapaneseOnDemandDictionary): OnDemandDictionary {
  return createOnDemandDictionary({ japanese });
}

function englishResolver(english: EnglishOnDemandDictionary): OnDemandDictionary {
  return createOnDemandDictionary({
    japanese: { resolve: async () => null },
    english
  });
}

function emptyDb(): LookupDb {
  return {
    lookup() {
      return { item: null, alternatives: [] };
    },
    meta() {
      return { apiVersion: "v1", dictionaryVersion: null, languages: [], tags: {}, sources: [] };
    },
    close() {}
  };
}

function generatedEntry(): PublicLookupItem {
  return {
    id: "yori:e_generated_test",
    word: "未知語",
    reading: "みちご",
    common: false,
    source: "generated",
    sourceId: "yori:e_generated_test",
    headwordLanguage: "ja",
    headwords: [{ text: "未知語", reading: "みちご", kind: "kanji", common: false, tags: [] }],
    senses: [
      {
        id: "yori:s_generated_test",
        position: 1,
        appliesTo: { kanji: ["*"], kana: ["*"] },
        partOfSpeech: ["n"],
        glosses: [
          { lang: "en", text: "unknown term", source: "generated", reviewStatus: "checked" },
          { lang: "zh-tw", text: "未知詞", source: "generated", reviewStatus: "checked" }
        ]
      }
    ]
  };
}

function englishEntry(): EnglishEntry {
  return {
    id: "yori:en:e_bank",
    dictionary: "en",
    headword: "bank",
    pronunciations: [],
    senses: [{
      id: "yori:en:s_bank_1",
      lang: "en",
      position: 1,
      partOfSpeech: "noun",
      glosses: [{ text: "a financial institution", source: "open-english-wordnet", reviewStatus: "source" }],
      registers: [],
      regions: [],
      domains: ["finance"],
      dated: false,
      usage: [],
      examples: [],
      evidenceIds: ["open-english-wordnet:bank:1"],
      provenance: "source"
    }],
    sources: []
  };
}
