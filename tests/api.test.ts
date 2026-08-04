import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { dataReleaseUrl } from "../src/data-release";
import { openLookupDb, type LookupDb } from "../src/db";

const testDbPath = "/tmp/yori-dict-api-test.sqlite";
let lookupDb: LookupDb;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await Bun.$`rm -f ${testDbPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --jlpt-vocab fixtures/jlpt-vocab --out ${testDbPath}`;
  const writableDb = new Database(testDbPath);
  writableDb
    .prepare(
      `insert into examples
        (sense_id, position, text, translations, source, review_status)
       values (?, 1, ?, ?, 'generated', 'checked')`
    )
    .run(
      "yori:s_jmdict_1283190_1",
      "それは高かったです。",
      JSON.stringify([{ lang: "en", text: "It was expensive." }])
    );
  writableDb.close();
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
  expect(body.dataRelease).toBe("https://github.com/YoriJP/yori-dict/releases/tag/data-2026-08-04.3");
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
  const body = await res.text();
  expect(body).toStartWith("openapi: 3.1.0");
  expect(body).toContain(`dataRelease: ${dataReleaseUrl}`);
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
  expect(body.tags.uk).toBe("word usually written using kana alone");
  expect(body.tags.vt).toBe("transitive verb");
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

test("returns headword language, sourced sense examples, and the easiest estimated level", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B");
  const body = await res.json();
  expect(body.item.headwordLanguage).toBe("ja");
  expect(body.item.estimatedLevel).toBe("N5");
  expect(body.item.senses[0].examples).toEqual([
    {
      text: "もっと果物を食べるべきです。",
      translations: [{ lang: "en", text: "You should eat more fruit." }],
      source: "sourced",
      sourceName: "Tatoeba",
      sourceId: "193344",
      reviewStatus: "source"
    }
  ]);
});

test("matches examples to the exact sense when the source has fewer senses", async () => {
  const res = await app.request("/v1/lookup?q=%E9%85%8D%E3%81%86");
  const body = await res.json();
  expect(body.item.senses[0]).not.toHaveProperty("examples");
  expect(body.item.senses[1].examples[0].sourceId).toBe("114734");
});

test("omits an example when identical senses make its attachment ambiguous", async () => {
  const res = await app.request("/v1/lookup?q=%E3%81%82%E3%81%84%E3%81%BE%E3%81%84%E8%AA%9E");
  const body = await res.json();
  expect(body.item.senses).toHaveLength(2);
  expect(body.item.senses[0]).not.toHaveProperty("examples");
  expect(body.item.senses[1]).not.toHaveProperty("examples");
});

test("represents generated examples distinctly without generating them at lookup time", async () => {
  const res = await app.request("/v1/lookup?q=%E9%AB%98%E3%81%84");
  const body = await res.json();
  expect(body.item.senses[0].examples).toEqual([
    {
      text: "それは高かったです。",
      translations: [{ lang: "en", text: "It was expensive." }],
      source: "generated",
      reviewStatus: "checked"
    }
  ]);
});

test("omits estimated level when the source lists do not cover an entry", async () => {
  const res = await app.request("/v1/lookup?q=%E8%AA%AD%E3%82%80");
  const body = await res.json();
  expect(body.item).not.toHaveProperty("estimatedLevel");
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

test("returns sense annotations when JMdict has them", async () => {
  const res = await app.request("/v1/lookup?q=%E7%B6%BA%E9%BA%97");
  const body = await res.json();
  const sense = body.item.senses[0];
  expect(sense.misc).toEqual(["uk"]);
  expect(sense.info).toEqual(["also written as 奇麗"]);
  expect(sense.antonym).toEqual([["汚い", "きたない", 1]]);
  expect(sense.glosses[1].type).toBe("figurative");
});

test("returns loanword origin and field tags", async () => {
  const res = await app.request("/v1/lookup?q=%E3%83%91%E3%82%BD%E3%82%B3%E3%83%B3");
  const body = await res.json();
  const sense = body.item.senses[0];
  expect(sense.field).toEqual(["comp"]);
  expect(sense.related).toEqual([["パーソナルコンピューター"]]);
  expect(sense.languageSource).toEqual([
    { lang: "eng", full: false, wasei: true, text: "personal computer" }
  ]);
});

test("returns dialect tags", async () => {
  const res = await app.request("/v1/lookup?q=%E3%81%82%E3%81%8B%E3%82%93");
  const body = await res.json();
  expect(body.item.senses[0].dialect).toEqual(["ksb"]);
  expect(body.item.senses[0].misc).toEqual(["uk", "col"]);
});

test("omits empty sense annotations", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B");
  const body = await res.json();
  const sense = body.item.senses[0];
  expect(sense).not.toHaveProperty("misc");
  expect(sense).not.toHaveProperty("field");
  expect(sense).not.toHaveProperty("languageSource");
  expect(sense.glosses[0]).not.toHaveProperty("type");
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
  expect(body.item.inflectionPath).toEqual([
    { from: "食べました", to: "食べる", reason: "polite past" }
  ]);
});

test("omits an inflection path for an exact lookup", async () => {
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B");
  const body = await res.json();
  expect(body.item).not.toHaveProperty("inflectionPath");
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
