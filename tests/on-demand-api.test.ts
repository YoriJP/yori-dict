import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { LookupDb } from "../src/db";
import { createOnDemandDictionary, ModelGatewayError } from "../src/on-demand-dictionary";
import type {
  EnglishOnDemandDictionary,
  JapaneseOnDemandDictionary,
  OnDemandDictionary,
  ResolveRequest
} from "../src/on-demand-dictionary";
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
