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
      `insert into ja_examples
        (sense_id, position, text, translations, source, review_status)
       values (?, 1, ?, ?, 'generated', 'checked')`
    )
    .run(
      "yori:s_jmdict_1283190_1:en",
      "それは高かったです。",
      JSON.stringify([{ lang: "en", text: "It was expensive." }])
    );
  addTaiwaneseMeaning(writableDb, "yori:s_jmdict_1358280_1", "吃");
  writableDb.close();
  lookupDb = openLookupDb(testDbPath);
  app = createApp(lookupDb);
});

afterAll(() => {
  lookupDb.close();
  new Database(testDbPath).close();
});

/**
 * Legacy accepted Taiwanese content maps onto an exact imported sense and
 * becomes that language's own sense rather than another gloss on the English
 * sense.
 */
function addTaiwaneseMeaning(db: Database, baseSenseId: string, gloss: string): void {
  const source = db
    .query<Record<string, unknown>, [string]>("select * from ja_senses where id = ?")
    .get(`${baseSenseId}:en`)!;
  const row: Record<string, unknown> = { ...source, id: `${baseSenseId}:zh-tw`, lang: "zh-tw", position: 1, provenance: "generated", source_name: "yori-legacy", source_ref: baseSenseId };
  const columns = Object.keys(row);
  db.prepare(`insert into ja_senses (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column] as never));
  db.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, ?, 'generated', 'checked')"
  ).run(`${baseSenseId}:zh-tw`, gloss);
}

async function lookup(query: string, lang = "en", extra = ""): Promise<any> {
  const res = await app.request(
    `/v1/lookup?q=${encodeURIComponent(query)}&dictionary=ja&lang=${lang}${extra}`
  );
  expect(res.status).toBe(200);
  return res.json();
}

test("returns API index links from the root route", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("Yori Dict");
  expect(body.description).toBe("Open Japanese and English dictionary lookup backed by independent data releases.");
  expect(body.health).toBe("/health");
  expect(body.meta).toBe("/v1/meta");
  expect(body.lookup).toContain("dictionary=ja");
  expect(body.docs).toBe("/doc");
  expect(body.openapi).toBe("/openapi.yaml");
  expect(body.dataRelease).toBe(dataReleaseUrl);
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
  expect(body).toContain("accepts: [en, de, zh-tw, zh-cn, ko, ja]");
  expect(body).toContain("`ja` supports en, de, zh-tw, zh-cn, ko, and ja");
  expect(body).toContain("A Japanese Explanation Group uses");
  expect(body).toContain("an empty list because its Monolingual Sense Example");
});

test("returns metadata", async () => {
  const res = await app.request("/v1/meta");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.apiVersion).toBe("v1");
  expect(body.dictionaryVersion).toBe("2026-06-08");
  // Metadata is derived from the rows that exist, so it names only the
  // languages a query would actually find content in. This database carries
  // English and legacy Taiwanese Japanese senses and no English dictionary,
  // and `de` — a supported language with nothing behind it yet — is absent.
  // `accepts` stays put while `languages` follows the rows, so a dictionary
  // with nothing mounted still reports what a lookup would take.
  expect(body.dictionaries).toEqual({
    ja: { languages: ["en", "zh-tw"], accepts: ["en", "de", "zh-tw", "zh-cn", "ko", "ja"] },
    en: { languages: [], accepts: ["en", "ja", "zh-tw"] }
  });
  expect(body.languages).toEqual(["en", "zh-tw"]);
  // Every credit points somewhere a reader can follow.
  for (const source of body.sources) {
    expect(source.url).toMatch(/^https:\/\//);
    expect(source.license).not.toBe("");
  }
  expect(body.sources).toContainEqual({
    name: "Yori generated zh-CN glosses (legacy records)",
    license: "CC-BY-SA-4.0",
    url: "https://github.com/YoriJP/yori-dict/blob/main/sources/ai-glosses/zh-cn.jsonl"
  });
  expect(body.tags.uk).toBe("word usually written using kana alone");
  expect(body.tags.vt).toBe("transitive verb");
});

test("looks up an exact Japanese headword in the requested language", async () => {
  const entry = await lookup("食べる", "zh-tw");
  expect(entry.id).toBe("yori:e_jmdict_1358280");
  expect(entry.dictionary).toBe("ja");
  expect(entry.lang).toBe("zh-tw");
  expect(entry.headword).toBe("食べる");
  expect(entry.reading).toBe("たべる");
  expect(entry.sources).toEqual(["jmdict:1358280"]);
  expect(entry.senses).toHaveLength(1);
  expect(entry.senses[0].glosses[0].text).toBe("吃");
});

test("legacy accepted content reads as generated provenance in its own language", async () => {
  const entry = await lookup("食べる", "zh-tw");
  expect(entry.senses[0].glosses[0]).toEqual({
    text: "吃",
    source: "generated",
    reviewStatus: "checked"
  });
});

test("returns sourced examples and the easiest estimated level", async () => {
  const entry = await lookup("食べる");
  expect(entry.estimatedLevel).toBe("N5");
  expect(entry.senses[0].examples).toEqual([
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
  const entry = await lookup("配う");
  expect(entry.senses[0].examples).toEqual([]);
  expect(entry.senses[1].examples[0].sourceId).toBe("114734");
});

test("omits an example when identical senses make its attachment ambiguous", async () => {
  const entry = await lookup("あいまい語");
  expect(entry.senses).toHaveLength(2);
  expect(entry.senses[0].examples).toEqual([]);
  expect(entry.senses[1].examples).toEqual([]);
});

test("represents generated examples distinctly without generating them at lookup time", async () => {
  const entry = await lookup("高い");
  expect(entry.senses[0].examples).toEqual([
    {
      text: "それは高かったです。",
      translations: [{ lang: "en", text: "It was expensive." }],
      source: "generated",
      reviewStatus: "checked"
    }
  ]);
});

test("omits estimated level when the source lists do not cover an entry", async () => {
  const entry = await lookup("読む");
  expect(entry).not.toHaveProperty("estimatedLevel");
});

test("preserves form tags and sense applicability", async () => {
  const entry = await lookup("配う");
  expect(entry.headwords).toContainEqual({
    text: "配う",
    reading: "あしらう",
    kind: "kanji",
    common: false,
    tags: ["sK"]
  });
  expect(entry.senses[0].appliesTo).toEqual({
    kanji: ["遇う"],
    kana: ["*"]
  });
});

test("returns sense annotations when JMdict has them", async () => {
  const entry = await lookup("綺麗");
  const sense = entry.senses[0];
  expect(sense.misc).toEqual(["uk"]);
  expect(sense.info).toEqual(["also written as 奇麗"]);
  expect(sense.antonym).toEqual([["汚い", "きたない", 1]]);
  expect(sense.glosses[1].type).toBe("figurative");
});

test("returns loanword origin and field tags", async () => {
  const entry = await lookup("パソコン");
  const sense = entry.senses[0];
  expect(sense.field).toEqual(["comp"]);
  expect(sense.related).toEqual([["パーソナルコンピューター"]]);
  expect(sense.languageSource).toEqual([
    { lang: "eng", full: false, wasei: true, text: "personal computer" }
  ]);
});

test("returns dialect tags", async () => {
  const entry = await lookup("あかん");
  expect(entry.senses[0].dialect).toEqual(["ksb"]);
  expect(entry.senses[0].misc).toEqual(["uk", "col"]);
});

test("omits empty sense annotations", async () => {
  const entry = await lookup("食べる");
  const sense = entry.senses[0];
  expect(sense).not.toHaveProperty("misc");
  expect(sense).not.toHaveProperty("field");
  expect(sense).not.toHaveProperty("languageSource");
  expect(sense.glosses[0]).not.toHaveProperty("type");
});

test("looks up by reading", async () => {
  expect((await lookup("たべる")).headword).toBe("食べる");
});

test("returns an entry for deinflected ichidan forms", async () => {
  const entry = await lookup("食べました");
  expect(entry.id).toBe("yori:e_jmdict_1358280");
  expect(entry.headword).toBe("食べる");
  expect(entry.inflectionPath).toEqual([
    { from: "食べました", to: "食べる", reason: "polite past" }
  ]);
});

test("omits an inflection path for an exact lookup", async () => {
  expect(await lookup("食べる")).not.toHaveProperty("inflectionPath");
});

test("returns an entry for deinflected godan forms", async () => {
  const entry = await lookup("読んだ");
  expect(entry.id).toBe("yori:e_jmdict_1456360");
  expect(entry.headword).toBe("読む");
});

test("returns an entry for deinflected godan negative forms", async () => {
  const entry = await lookup("行かなかった");
  expect(entry.id).toBe("yori:e_jmdict_1578850");
  expect(entry.headword).toBe("行く");
});

test("keeps exact matches ranked first", async () => {
  const entry = await lookup("高い");
  expect(entry.id).toBe("yori:e_jmdict_1283190");
  expect(entry.headword).toBe("高い");
});

test("prefers a kana-primary entry for ambiguous kana queries", async () => {
  const kana = await lookup("くらい");
  expect(kana.id).toBe("yori:e_jmdict_2000002");
  expect(kana.headword).toBe("くらい");

  const kanji = await lookup("暗い");
  expect(kanji.id).toBe("yori:e_jmdict_2000001");
  expect(kanji.headword).toBe("暗い");
});

test("returns one ordered entry per batch query without repeating the queries", async () => {
  const res = await app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dictionary: "ja",
      lang: "zh-tw",
      queries: ["食べました", "学校", "存在しない語"]
    })
  });
  const body = await res.json();
  expect(Object.keys(body)).toEqual(["entries"]);
  expect(body.entries).toHaveLength(3);
  expect(body.entries[0].id).toBe("yori:e_jmdict_1358280");
  expect(body.entries[1]).toBeNull();
  expect(body.entries[2]).toBeNull();
});
