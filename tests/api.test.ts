import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";

const testDbPath = "/tmp/yori-dict-api-test.sqlite";
let lookupDb: LookupDb;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await Bun.$`rm -f ${testDbPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${testDbPath}`;
  lookupDb = openLookupDb(testDbPath);
  app = createApp(lookupDb);
});

afterAll(() => {
  lookupDb.close();
  new Database(testDbPath).close();
});

test("returns API index links from the root route", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("Yori Dict");
  expect(body.description).toBe("Open Japanese dictionary API and SQLite database with multilingual lookup support.");
  expect(body.health).toBe("/health");
  expect(body.meta).toBe("/v1/meta");
  expect(body.docs).toBe("/doc");
  expect(body.openapi).toBe("/openapi.yaml");
  expect(body.dataRelease).toBe("https://github.com/anilahsu/yori-dict/releases/tag/data-2026-06-11");
});

test("serves Scalar API reference from the doc route", async () => {
  const res = await app.request("/doc");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("Yori Dict API Docs");
  expect(body).toContain("scalar");
  expect(body).toContain("/openapi.yaml");
});

test("serves OpenAPI YAML from the OpenAPI route", async () => {
  const res = await app.request("/openapi.yaml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/yaml");
  expect(await res.text()).toStartWith("openapi: 3.1.0");
});

test("returns metadata", async () => {
  const res = await app.request("/v1/meta");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.apiVersion).toBe("v1");
  expect(body.dictionaryVersion).toBe("2026-06-08");
  expect(body.sources).toContainEqual({
    name: "Yori AI-assisted zh-CN glosses",
    license: "CC-BY-SA-4.0",
    url: "sources/ai-glosses/zh-cn.jsonl"
  });
  expect(body.sources).toContainEqual({
    name: "Yori AI-assisted Korean glosses",
    license: "CC-BY-SA-4.0",
    url: "sources/ai-glosses/ko.jsonl"
  });
});

test("looks up an exact Japanese headword", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&lang=zh-tw");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.item.id).toBe("yori:e_jmdict_1358280");
  expect(body.item.word).toBe("食べる");
  expect(body.item.reading).toBe("たべる");
  expect(body.item.senses).toEqual([]);
});

test("defaults lookup glosses to English", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.item.senses[0].glosses[0].text).toBe("to eat");
});

test("preserves form tags and sense applicability", async () => {
  const res = await app.request("/v1/lookup?q=%E9%85%8D%E3%81%86");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.item.headwords).toContainEqual({
    text: "配う",
    reading: "あしらう",
    kind: "kanji",
    common: false,
    tags: ["sK"]
  });
  expect(body.item.senses[0].appliesTo).toEqual({
    kanji: ["遇う"],
    kana: ["*"]
  });
});

test("looks up by reading", async () => {
  const res = await app.request("/v1/lookup?q=%E3%81%9F%E3%81%B9%E3%82%8B");
  const body = await res.json();
  expect(body.item.word).toBe("食べる");
});

test("returns an item for deinflected ichidan forms", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%81%BE%E3%81%97%E3%81%9F");
  const body = await res.json();
  expect(body.item.id).toBe("yori:e_jmdict_1358280");
  expect(body.item.word).toBe("食べる");
});

test("returns an item for deinflected godan forms", async () => {
  const res = await app.request("/v1/lookup?q=%E8%AA%AD%E3%82%93%E3%81%A0");
  const body = await res.json();
  expect(body.item.id).toBe("yori:e_jmdict_1456360");
  expect(body.item.word).toBe("読む");
});

test("returns an item for deinflected godan negative forms", async () => {
  const res = await app.request("/v1/lookup?q=%E8%A1%8C%E3%81%8B%E3%81%AA%E3%81%8B%E3%81%A3%E3%81%9F");
  const body = await res.json();
  expect(body.item.id).toBe("yori:e_jmdict_1578850");
  expect(body.item.word).toBe("行く");
});

test("keeps exact matches ranked first", async () => {
  const res = await app.request("/v1/lookup?q=%E9%AB%98%E3%81%84");
  const body = await res.json();
  expect(body.item.id).toBe("yori:e_jmdict_1283190");
  expect(body.item.word).toBe("高い");
});

test("prefers a kana-primary entry for ambiguous kana queries", async () => {
  const kanaRes = await app.request("/v1/lookup?q=%E3%81%8F%E3%82%89%E3%81%84");
  const kanaBody = await kanaRes.json();
  expect(kanaBody.item.id).toBe("yori:e_jmdict_2000002");
  expect(kanaBody.item.word).toBe("くらい");

  const kanjiRes = await app.request("/v1/lookup?q=%E6%9A%97%E3%81%84");
  const kanjiBody = await kanjiRes.json();
  expect(kanjiBody.item.id).toBe("yori:e_jmdict_2000001");
  expect(kanjiBody.item.word).toBe("暗い");
});

test("returns one result per batch query in input order", async () => {
  const res = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: ["食べました", "学校", "存在しない語"], lang: "zh-tw" })
  });
  const body = await res.json();
  expect(body.results.map((result: { input: string }) => result.input)).toEqual([
    "食べました",
    "学校",
    "存在しない語"
  ]);
  expect(body.results[0].item.id).toBe("yori:e_jmdict_1358280");
  expect(body.results[1].item.id).toBe("yori:e_jmdict_1206730");
  expect(body.results[2].item).toBeNull();
});
