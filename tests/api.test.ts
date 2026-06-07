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

test("returns metadata", async () => {
  const res = await app.request("/v1/meta");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.apiVersion).toBe("v1");
  expect(body.dictionaryVersion).toBe("2026-06-08");
});

test("looks up an exact Japanese headword", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&lang=zh-tw");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.matches[0].matchType).toBe("exact");
  expect(body.entries[0].id).toBe("yori:e_jmdict_1358280");
  expect(body.entries[0].senses[0].glosses["zh-tw"]).toEqual([]);
  expect(body.entries[0].senses[0].glosses.en[0].text).toBe("to eat");
});

test("preserves form tags and sense applicability", async () => {
  const res = await app.request("/v1/lookup?q=%E9%85%8D%E3%81%86");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entries[0].headwords).toContainEqual({
    text: "配う",
    reading: "あしらう",
    kind: "kanji",
    common: false,
    tags: ["sK"]
  });
  expect(body.entries[0].senses[0].appliesTo).toEqual({
    kanji: ["遇う"],
    kana: ["*"]
  });
});

test("looks up by reading", async () => {
  const res = await app.request("/v1/lookup?q=%E3%81%9F%E3%81%B9%E3%82%8B");
  const body = await res.json();
  expect(body.entries[0].headwords[0].text).toBe("食べる");
});

test("returns deinflected matches", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%81%BE%E3%81%97%E3%81%9F");
  const body = await res.json();
  expect(body.matches).toContainEqual({
    input: "食べました",
    matchedForm: "食べる",
    matchType: "deinflected",
    rank: 10,
    reasons: ["polite past"]
  });
  expect(body.entries[0].id).toBe("yori:e_jmdict_1358280");
});

test("returns deinflected godan matches", async () => {
  const res = await app.request("/v1/lookup?q=%E8%AA%AD%E3%82%93%E3%81%A0");
  const body = await res.json();
  expect(body.matches).toContainEqual({
    input: "読んだ",
    matchedForm: "読む",
    matchType: "deinflected",
    rank: 10,
    reasons: ["godan past"]
  });
  expect(body.entries[0].id).toBe("yori:e_jmdict_1456360");
});

test("returns deinflected godan negative matches", async () => {
  const res = await app.request("/v1/lookup?q=%E8%A1%8C%E3%81%8B%E3%81%AA%E3%81%8B%E3%81%A3%E3%81%9F");
  const body = await res.json();
  expect(body.matches).toContainEqual({
    input: "行かなかった",
    matchedForm: "行く",
    matchType: "deinflected",
    rank: 10,
    reasons: ["godan negative past"]
  });
  expect(body.entries[0].id).toBe("yori:e_jmdict_1578850");
});

test("keeps exact matches ranked first", async () => {
  const res = await app.request("/v1/lookup?q=%E9%AB%98%E3%81%84");
  const body = await res.json();
  expect(body.matches[0]).toEqual({
    input: "高い",
    matchedForm: "高い",
    matchType: "exact",
    rank: 0,
    reasons: []
  });
});

test("returns one result per batch query in input order", async () => {
  const res = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: ["食べました", "学校", "存在しない語"], lang: "zh-tw" })
  });
  const body = await res.json();
  expect(body.results.map((result: { query: string }) => result.query)).toEqual([
    "食べました",
    "学校",
    "存在しない語"
  ]);
  expect(body.results[0].entries[0].id).toBe("yori:e_jmdict_1358280");
  expect(body.results[1].entries[0].id).toBe("yori:e_jmdict_1206730");
  expect(body.results[2].entries).toEqual([]);
});
