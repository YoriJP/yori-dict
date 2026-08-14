import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import { openEnrichmentRepository, type PersistentEnrichmentRepository } from "../src/enrichment-repository";
import { migrateProductionDatabase } from "../src/production-database";
import {
  createJapaneseOnDemandDictionary,
  createOnDemandDictionary,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from "../src/on-demand-dictionary";

/**
 * Responses are scripted per role because examples for different senses are
 * generated concurrently. Any unscripted call fails the test, so public lookup
 * cannot spend.
 */
class ScriptedGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  responses = new Map<string, string[]>();

  script(role: string, ...texts: string[]): void {
    this.responses.set(role, [...(this.responses.get(role) ?? []), ...texts]);
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const text = this.responses.get(request.role)?.shift();
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
    this.responses.clear();
  }

  roles(): string[] {
    return this.calls.map(({ role }) => role);
  }
}

const gateway = new ScriptedGateway();
let lookupDb: LookupDb;
let repository: PersistentEnrichmentRepository;
let app: ReturnType<typeof createApp>;
let twoPassApp: ReturnType<typeof createApp>;
let dbPath: string;

beforeAll(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), "yori-ja-enrich-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`.quiet();
  migrateProductionDatabase(dbPath);
  lookupDb = openLookupDb(dbPath);
  repository = openEnrichmentRepository(dbPath, lookupDb);
  app = createApp(lookupDb, {
    enrichmentToken: "owner-token",
    onDemand: createOnDemandDictionary({
      japanese: createJapaneseOnDemandDictionary({ repository, modelGateway: gateway })
    })
  });
  twoPassApp = createApp(lookupDb, {
    enrichmentToken: "owner-token",
    onDemand: createOnDemandDictionary({
      japanese: createJapaneseOnDemandDictionary({ repository, modelGateway: gateway, reviewPasses: 2 })
    })
  });
});

afterAll(() => {
  repository.close();
  lookupDb.close();
});

async function enrich(query: string, lang: string, targetApp = app) {
  const response = await targetApp.request(
    `/v1/lookup?q=${encodeURIComponent(query)}&dictionary=ja&lang=${lang}&enrich=true`,
    { headers: { authorization: "Bearer owner-token" } }
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function read(query: string, lang: string) {
  const response = await app.request(`/v1/lookup?q=${encodeURIComponent(query)}&dictionary=ja&lang=${lang}`);
  expect(response.status).toBe(200);
  return response.json();
}

function authored(glosses: string[]): string {
  return authoredWord("未知語", "みちご", glosses);
}

function authoredWord(headword: string, reading: string, glosses: string[]): string {
  return JSON.stringify({
    headword,
    reading,
    senses: glosses.map((gloss) => ({
      partOfSpeech: ["n"],
      registers: [],
      domains: [],
      dialect: [],
      pronunciations: [],
      pragmaticFunctions: [],
      glosses: [gloss],
      evidenceIds: [],
      provenance: "generated"
    }))
  });
}

function example(translation: string): string {
  return JSON.stringify({ sentence: "この未知語の意味を調べた。", translation });
}

function monolingualExample(sentence = "この未知語の意味を調べた。"): string {
  return JSON.stringify({ sentence });
}

test("one author request fills one missing entry-language group", async () => {
  gateway.reset();
  expect(await read("未知語", "en")).toBeNull();

  gateway.script("eligibility", "未知語");
  gateway.script("entry-author", authored(["unknown term", "unlisted word"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", example("I looked this word up."), example("I used this word today."));
  gateway.script("example-review", "ACCEPT", "ACCEPT");
  const entry = await enrich("未知語", "en");
  expect(entry.lang).toBe("en");
  expect(entry.senses.map((sense: { glosses: Array<{ text: string }> }) => sense.glosses[0].text))
    .toEqual(["unknown term", "unlisted word"]);
  expect(gateway.roles().filter((role) => role.startsWith("entry"))).toEqual(["entry-author", "entry-review"]);

  // The accepted group is canonical, and no other language was created.
  expect((await read("未知語", "en")).senses).toHaveLength(2);
  expect(await read("未知語", "zh-tw")).toBeNull();
  expect(await read("未知語", "ko")).toBeNull();
});

test("a second language is authored independently without rewriting the first", async () => {
  gateway.reset();
  gateway.script("entry-author", authored(["未知的詞語"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", example("我查了這個詞的意思。"));
  gateway.script("example-review", "ACCEPT");
  const taiwanese = await enrich("未知語", "zh-tw");
  // The entry is already canonical in another language, so filling the missing
  // group needs no eligibility decision.
  expect(gateway.roles()).not.toContain("eligibility");

  // A different sense count, different identifiers, and its own wording.
  expect(taiwanese.senses).toHaveLength(1);
  expect(taiwanese.senses[0].glosses[0].text).toBe("未知的詞語");
  expect(taiwanese.senses[0].id).not.toBe((await read("未知語", "en")).senses[0].id);
  expect(taiwanese.senses[0].examples[0].translations).toEqual([
    { lang: "zh-tw", text: "我查了這個詞的意思。" }
  ]);

  const english = await read("未知語", "en");
  expect(english.senses.map((sense: { glosses: Array<{ text: string }> }) => sense.glosses[0].text))
    .toEqual(["unknown term", "unlisted word"]);
});

test("an authorized lookup authors and persists an independent Japanese Explanation Group", async () => {
  gateway.reset();
  expect(await read("未知語", "ja")).toBeNull();

  gateway.script("entry-author", authored(["意味がまだ知られていない語"]));
  gateway.script("entry-review", "ACCEPT");
  // Example completion is a separate retryable gap. These malformed candidates
  // prove the accepted Explanation Group survives without pulling #53 into
  // this slice.
  gateway.script("example-author", "{}", "{}");
  const japanese = await enrich("未知語", "ja");

  expect(japanese.lang).toBe("ja");
  expect(japanese.senses[0].glosses[0].text).toBe("意味がまだ知られていない語");
  expect(japanese.senses[0].examples).toEqual([]);
  expect((await read("未知語", "ja")).senses[0].id).toBe(japanese.senses[0].id);
  const meta = await (await app.request("/v1/meta")).json();
  expect(meta.dictionaries.ja.languages).toContain("ja");
  expect((await read("未知語", "en")).senses).toHaveLength(2);
  expect((await read("未知語", "zh-tw")).senses).toHaveLength(1);
});

test("Japanese authoring rejects wrong-script and objectively Circular Glosses before review", async () => {
  for (const candidate of [
    { headword: "循環語", reading: "じゅんかんご", gloss: "循環語のこと" },
    { headword: "説明語", reading: "せつめいご", gloss: "せつめいごという意味" },
    { headword: "新語", reading: "しんご", gloss: "摂食" }
  ]) {
    gateway.reset();
    gateway.script("eligibility", candidate.headword);
    gateway.script("entry-author", authoredWord(candidate.headword, candidate.reading, [candidate.gloss]));
    expect(await enrich(candidate.headword, "ja")).toBeNull();
    expect(gateway.roles()).toEqual(["eligibility", "entry-author"]);
    expect(await read(candidate.headword, "ja")).toBeNull();
  }

  gateway.reset();
  gateway.script("eligibility", "定義語");
  gateway.script("entry-author", authoredWord("定義語", "ていぎご", ["定義語とは、意味を詳しく説明する語"]));
  gateway.script("entry-review", "REJECT");
  expect(await enrich("定義語", "ja")).toBeNull();
  expect(gateway.roles()).toEqual(["eligibility", "entry-author", "entry-review"]);
});

test("a Japanese Explanation Group completes with a Monolingual Sense Example", async () => {
  gateway.reset();
  // A redundant self-translation violates the strict Japanese author contract.
  // Both candidates fail before review and leave the Example gap retryable.
  gateway.script(
    "example-author",
    JSON.stringify({ sentence: "この未知語の意味を調べた。", translation: "この未知語の意味を調べた。" }),
    JSON.stringify({ sentence: "今日は未知語を一つ覚えた。", translation: "今日は未知語を一つ覚えた。" })
  );
  const malformed = await enrich("未知語", "ja");
  expect(malformed.senses[0].examples).toEqual([]);
  expect(gateway.roles()).toEqual(["example-author", "example-author"]);

  gateway.reset();
  gateway.script("example-author", monolingualExample());
  gateway.script("example-review", "ACCEPT");
  const completed = await enrich("未知語", "ja");
  expect(completed.senses[0].examples[0]).toEqual({
    text: "この未知語の意味を調べた。",
    translations: [],
    source: "generated",
    reviewStatus: "checked"
  });

  // The accepted Example is canonical and closes the gap without changing the
  // bilingual requirements or spending again on a later authorized lookup.
  expect((await read("未知語", "ja")).senses[0].examples[0].translations).toEqual([]);
  gateway.reset();
  await enrich("未知語", "ja");
  expect(gateway.calls).toEqual([]);
});

test("Japanese entry and Example review require two unanimous passes", async () => {
  gateway.reset();
  gateway.script("eligibility", "二段語");
  gateway.script("entry-author", authoredWord("二段語", "にだんご", ["二つの段階で確認する語"]));
  gateway.script("entry-review", "ACCEPT", "REJECT");
  expect(await enrich("二段語", "ja", twoPassApp)).toBeNull();
  expect(await read("二段語", "ja")).toBeNull();
  expect(gateway.calls.filter(({ role }) => role === "entry-review").map(({ promptVersion }) => promptVersion))
    .toEqual(["entry-review-v5", "entry-review-v5-verification-v2"]);

  gateway.reset();
  gateway.script("eligibility", "全会語");
  gateway.script("entry-author", authoredWord("全会語", "ぜんかいご", ["全員の同意によって採用される語"]));
  gateway.script("entry-review", "ACCEPT", "ACCEPT");
  gateway.script("example-author", monolingualExample("この全会語は全員の同意を得た。"));
  gateway.script("example-review", "ACCEPT", "REJECT");
  const withoutExample = await enrich("全会語", "ja", twoPassApp);
  expect(withoutExample.senses[0].examples).toEqual([]);
  expect((await read("全会語", "ja")).senses[0].examples).toEqual([]);

  gateway.reset();
  gateway.script("example-author", monolingualExample("この全会語は全員の同意を得た。"));
  gateway.script("example-review", "ACCEPT", "ACCEPT");
  const completed = await enrich("全会語", "ja", twoPassApp);
  expect(completed.senses[0].examples[0].translations).toEqual([]);
  expect(gateway.calls.filter(({ role }) => role === "example-review").map(({ promptVersion }) => promptVersion))
    .toEqual(["example-review-v6", "example-review-v6-verification-v2"]);
});

test("a sourced monolingual Japanese Example closes the Example gap", async () => {
  gateway.reset();
  gateway.script("eligibility", "出典語");
  gateway.script("entry-author", authoredWord("出典語", "しゅってんご", ["出典が明らかにされている語"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", "{}", "{}");
  const authoredEntry = await enrich("出典語", "ja");
  expect(authoredEntry.senses[0].examples).toEqual([]);

  const seed = new Database(dbPath);
  seed.prepare(`
    insert into ja_examples (
      sense_id, position, text, translations, source, source_name, source_id, review_status, generation_id
    ) values (?, 1, ?, '[]', 'sourced', 'fixture', 'ja-source-1', 'source', null)
  `).run(authoredEntry.senses[0].id, "この出典語は資料に記録されている。");
  seed.close();

  gateway.reset();
  const completed = await enrich("出典語", "ja");
  expect(completed.senses[0].examples[0]).toEqual({
    text: "この出典語は資料に記録されている。",
    translations: [],
    source: "sourced",
    sourceName: "fixture",
    sourceId: "ja-source-1",
    reviewStatus: "source"
  });
  expect(gateway.calls).toEqual([]);
});

test("a rejected language group never becomes visible and spares the accepted ones", async () => {
  gateway.reset();
  gateway.script("entry-author", authored(["unbekanntes Wort"]));
  gateway.script("entry-review", "REJECT");
  expect(await enrich("未知語", "de")).toBeNull();
  expect(await read("未知語", "de")).toBeNull();

  expect((await read("未知語", "en")).senses).toHaveLength(2);
  expect((await read("未知語", "zh-tw")).senses).toHaveLength(1);
});

test("a rejected example keeps accepted senses and allows one fresh later attempt", async () => {
  gateway.reset();
  gateway.script("entry-author", authored(["알 수 없는 단어"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script(
    "example-author",
    example("나는 이 단어를 찾아보았다."),
    example("나는 오늘 이 단어를 사용했다.")
  );
  gateway.script("example-review", "REJECT", "REJECT");
  const rejected = await enrich("未知語", "ko");

  // The sense survived the rejected example, and the example was not saved.
  expect(rejected.senses).toHaveLength(1);
  expect(rejected.senses[0].glosses[0].text).toBe("알 수 없는 단어");
  expect(rejected.senses[0].examples).toEqual([]);
  expect((await read("未知語", "ko")).senses[0].examples).toEqual([]);

  gateway.reset();
  gateway.script("example-author", example("나는 이 단어를 찾아보았다."));
  gateway.script("example-review", "ACCEPT");
  const retried = await enrich("未知語", "ko");
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(retried.senses[0].examples[0].translations).toEqual([
    { lang: "ko", text: "나는 이 단어를 찾아보았다." }
  ]);

  // Once one accepted example exists, a later owner lookup stops generating.
  gateway.reset();
  await enrich("未知語", "ko");
  expect(gateway.calls).toEqual([]);
});

test("enrichment never rewrites correct imported content", async () => {
  gateway.reset();
  const before = await read("学校", "en");
  expect(before.senses[0].glosses[0].text).toBe("school");

  gateway.script("example-author", JSON.stringify({ sentence: "学校へ行きます。", translation: "I go to school." }));
  gateway.script("example-review", "ACCEPT");
  const enriched = await enrich("学校", "en");
  // Only the observable gap, the missing generated example, was filled.
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(enriched.senses[0].glosses).toEqual(before.senses[0].glosses);
  expect(enriched.senses[0].examples[0].text).toBe("学校へ行きます。");
});

test("a language group authored for an imported entry joins that entry", async () => {
  gateway.reset();
  const english = await read("学校", "en");
  expect(await read("学校", "zh-tw")).toBeNull();

  gateway.script("entry-author", JSON.stringify({
    headword: "学校",
    reading: "がっこう",
    senses: [{
      partOfSpeech: ["n"],
      registers: [],
      domains: [],
      dialect: [],
      pronunciations: [],
      pragmaticFunctions: [],
      glosses: ["學校"],
      evidenceIds: [],
      provenance: "generated"
    }]
  }));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", JSON.stringify({ sentence: "学校へ行きます。", translation: "我去學校。" }));
  gateway.script("example-review", "ACCEPT");
  const taiwanese = await enrich("学校", "zh-tw");

  // One entry, one identity: the authored group did not mint a second entry,
  // and the entry keeps the imported source facts it was published with.
  expect(taiwanese.id).toBe(english.id);
  expect(taiwanese.sources).toEqual(english.sources);
  expect(taiwanese.reading).toBe(english.reading);

  // Both groups are readable afterwards, each in its own language.
  const stored = await read("学校", "zh-tw");
  expect(stored.id).toBe(english.id);
  expect(stored.senses.map((sense: { glosses: Array<{ text: string }> }) => sense.glosses[0].text))
    .toEqual(["學校"]);
  expect((await read("学校", "en")).senses).toEqual(english.senses);
});

test("public lookup makes zero model calls even when a language is missing", async () => {
  gateway.reset();
  expect(await read("学校", "ko")).toBeNull();
  expect(await read("存在しない語", "en")).toBeNull();
  expect((await read("未知語", "en")).senses).toHaveLength(2);
  expect(gateway.calls).toEqual([]);
});
