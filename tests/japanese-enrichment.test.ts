import { afterAll, beforeAll, expect, test } from "bun:test";
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
 * Responses are scripted per role because examples for different meanings are
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

beforeAll(async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "yori-ja-enrich-")), "yori.sqlite");
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
});

afterAll(() => {
  repository.close();
  lookupDb.close();
});

async function enrich(query: string, lang: string) {
  const response = await app.request(
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
  return JSON.stringify({
    headword: "未知語",
    reading: "みちご",
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
  expect(entry.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(["unknown term", "unlisted word"]);
  expect(gateway.roles().filter((role) => role.startsWith("entry"))).toEqual(["entry-author", "entry-review"]);

  // The accepted group is canonical, and no other language was created.
  expect((await read("未知語", "en")).meanings).toHaveLength(2);
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

  // A different meaning count, different identifiers, and its own wording.
  expect(taiwanese.meanings).toHaveLength(1);
  expect(taiwanese.meanings[0].glosses[0].text).toBe("未知的詞語");
  expect(taiwanese.meanings[0].id).not.toBe((await read("未知語", "en")).meanings[0].id);
  expect(taiwanese.meanings[0].examples[0].translations).toEqual([
    { lang: "zh-tw", text: "我查了這個詞的意思。" }
  ]);

  const english = await read("未知語", "en");
  expect(english.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(["unknown term", "unlisted word"]);
});

test("a rejected language group never becomes visible and spares the accepted ones", async () => {
  gateway.reset();
  gateway.script("entry-author", authored(["unbekanntes Wort"]));
  gateway.script("entry-review", "REJECT");
  expect(await enrich("未知語", "de")).toBeNull();
  expect(await read("未知語", "de")).toBeNull();

  expect((await read("未知語", "en")).meanings).toHaveLength(2);
  expect((await read("未知語", "zh-tw")).meanings).toHaveLength(1);
});

test("a rejected example keeps accepted meanings and allows one fresh later attempt", async () => {
  gateway.reset();
  gateway.script("entry-author", authored(["알 수 없는 단어"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", example("나는 이 단어를 찾아보았다."));
  gateway.script("example-review", "REJECT");
  const rejected = await enrich("未知語", "ko");

  // The meaning survived the rejected example, and the example was not saved.
  expect(rejected.meanings).toHaveLength(1);
  expect(rejected.meanings[0].glosses[0].text).toBe("알 수 없는 단어");
  expect(rejected.meanings[0].examples).toEqual([]);
  expect((await read("未知語", "ko")).meanings[0].examples).toEqual([]);

  gateway.reset();
  gateway.script("example-author", example("나는 이 단어를 찾아보았다."));
  gateway.script("example-review", "ACCEPT");
  const retried = await enrich("未知語", "ko");
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(retried.meanings[0].examples[0].translations).toEqual([
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
  expect(before.meanings[0].glosses[0].text).toBe("school");

  gateway.script("example-author", JSON.stringify({ sentence: "学校へ行きます。", translation: "I go to school." }));
  gateway.script("example-review", "ACCEPT");
  const enriched = await enrich("学校", "en");
  // Only the observable gap, the missing generated example, was filled.
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(enriched.meanings[0].glosses).toEqual(before.meanings[0].glosses);
  expect(enriched.meanings[0].examples[0].text).toBe("学校へ行きます。");
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
  expect(stored.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(["學校"]);
  expect((await read("学校", "en")).meanings).toEqual(english.meanings);
});

test("public lookup makes zero model calls even when a language is missing", async () => {
  gateway.reset();
  expect(await read("学校", "ko")).toBeNull();
  expect(await read("存在しない語", "en")).toBeNull();
  expect((await read("未知語", "en")).meanings).toHaveLength(2);
  expect(gateway.calls).toEqual([]);
});
