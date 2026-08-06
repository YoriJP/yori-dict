import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { LookupDb } from "../src/db";
import type { OnDemandDictionary, ResolveRequest } from "../src/on-demand-dictionary";
import type { PublicLookupItem } from "../src/types";

test("public lookup stays model-free while authenticated enrichment delegates through resolve", async () => {
  const calls: ResolveRequest[] = [];
  const generated = generatedEntry();
  const onDemand: OnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return generated;
    }
  };
  const app = createApp(emptyDb(), { onDemand, enrichmentToken: "secret" });

  expect((await app.request("/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E")).status).toBe(200);
  expect(calls).toHaveLength(0);
  expect((await app.request("/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E&enrich=true")).status).toBe(401);
  expect(calls).toHaveLength(0);

  const response = await app.request(
    "/v1/lookup?q=%E6%9C%AA%E7%9F%A5%E8%AA%9E&enrich=true&lemma=%E6%9C%AA%E7%9F%A5%E8%AA%9E&reading=%E3%81%BF%E3%81%A1%E3%81%94&context=%E6%9C%AA%E7%9F%A5%E8%AA%9E%E3%82%92%E8%AA%BF%E3%81%B9%E3%81%9F%E3%80%82",
    { headers: { authorization: "Bearer secret" } }
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.item.word).toBe("未知語");
  expect(body.item.senses[0].glosses).toEqual([
    { text: "unknown term", source: "generated", reviewStatus: "checked" }
  ]);
  expect(calls).toEqual([
    {
      query: "未知語",
      targetDictionary: "ja",
      context: { lemma: "未知語", reading: "みちご", sentence: "未知語を調べた。" }
    }
  ]);
});

test("batch enrichment accepts contextual candidates while preserving string queries", async () => {
  const calls: ResolveRequest[] = [];
  const onDemand: OnDemandDictionary = {
    async resolve(request) {
      calls.push(request);
      return generatedEntry();
    }
  };
  const app = createApp(emptyDb(), { onDemand, enrichmentToken: "secret" });
  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({
      enrich: true,
      queries: [
        "未知語",
        { query: "取り組んで", lemma: "取り組む", reading: "とりくむ", context: "改革に取り組んでいる。" }
      ]
    })
  });

  expect(response.status).toBe(200);
  expect(calls).toEqual([
    { query: "未知語", targetDictionary: "ja", mode: "bulk" },
    {
      query: "取り組んで",
      targetDictionary: "ja",
      mode: "bulk",
      context: { lemma: "取り組む", reading: "とりくむ", sentence: "改革に取り組んでいる。" }
    }
  ]);
  expect((await response.json()).results.map((result: { input: string }) => result.input)).toEqual([
    "未知語",
    "取り組んで"
  ]);
});

test("batch enrichment falls back to released lookup when resolution fails", async () => {
  const released = generatedEntry();
  released.source = "jmdict";
  const db = emptyDb();
  db.lookup = () => ({ item: released });
  const app = createApp(db, {
    enrichmentToken: "secret",
    onDemand: { async resolve() { throw new Error("provider unavailable"); } }
  });

  const response = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ enrich: true, queries: ["学校"] })
  });

  expect(response.status).toBe(200);
  expect((await response.json()).results[0].item.word).toBe("未知語");
});

function emptyDb(): LookupDb {
  return {
    lookup() {
      return { item: null };
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
