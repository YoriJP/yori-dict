import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import {
  createEnrichmentService,
  filterCandidate,
  generatorConfig,
  makeGeminiRequestBody,
  parseGeneration,
  parseReview,
  translatorConfig,
  type GenerationSeed,
  type ModelCall
} from "../src/example-enrichment";
import { openExampleOverlay, type ExampleOverlay } from "../src/example-overlay";

const resources: Array<{ directory: string; db: LookupDb; overlay: ExampleOverlay }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    resource.overlay.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

test("parsers reject malformed generator output and reviewer prose or rewrites", () => {
  expect(() => parseGeneration("not json")).toThrow();
  expect(() => parseGeneration('{"sentence":"例です。","english":""}')).toThrow();
  expect(() => parseReview('{"id":"c1","decision":"accept","comment":"fine"}', "c1")).toThrow();
  expect(() => parseReview('{"id":"c1","decision":"reject","reason":"unnatural","rewrite":"x"}', "c1")).toThrow();
  expect(parseReview('{"id":"c1","decision":"reject","reason":"unnatural"}', "c1")).toEqual({
    decision: "reject",
    reason: "unnatural"
  });
});

test("deterministic filter accepts a conjugated target and rejects PRC terminology", () => {
  const seed: GenerationSeed = {
    senseId: "sense",
    word: "引く",
    reading: "ひく",
    forms: [{ text: "引く", kind: "kanji" }, { text: "ひく", kind: "kana" }],
    partOfSpeech: ["v5k"],
    tags: [],
    targetSense: ["to cite"],
    otherSenses: [["to pull"]]
  };
  expect(
    filterCandidate(seed, {
      kind: "candidate",
      sentence: "先生は例を引いて説明した。",
      translations: [
        { lang: "en", text: "The teacher explained with an example." },
        { lang: "zh-tw", text: "老師舉例說明。" }
      ]
    })
  ).toEqual([]);
  expect(
    filterCandidate(seed, {
      kind: "candidate",
      sentence: "先生は例を引いて説明した。",
      translations: [
        { lang: "en", text: "The teacher explained with an example." },
        { lang: "zh-tw", text: "老師查看視頻。" }
      ]
    })
  ).toContain("zh_tw_style");
});

test("authorised lookup fills a gap, persists provenance, and public lookup reuses it", async () => {
  let calls = 0;
  const translatorRequests: Array<ReturnType<typeof makeGeminiRequestBody>> = [];
  const runtime = await setup(async (input) => {
    calls += 1;
    expect(input.allowFallbacks).toBe(false);
    expect(input.requireParameters).toBe(true);
    if (input.role === "translator") translatorRequests.push(makeGeminiRequestBody(input));
    return validResponse(input.role, input.prompt);
  });
  const enriched = await runtime.app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1&enrich=true", {
    headers: { authorization: "Bearer test-token" }
  });
  expect(enriched.status).toBe(200);
  const enrichedBody = await enriched.json();
  expect(enrichedBody.item.senses[0].examples[0].source).toBe("generated");

  const record = runtime.overlay.read(enrichedBody.item.senses[0].id);
  expect(record?.status).toBe("accepted");
  expect(record?.attempts[0].generator).toEqual({
    model: "gemini-2.5-flash",
    reasoningEffort: "low",
    provider: "google"
  });
  expect(record?.attempts[0].reviewer?.provider).toBe("anthropic");
  expect(record?.attempts[0].translator).toEqual({
    model: "gemini-2.5-flash-lite",
    reasoningEffort: "none",
    provider: "google"
  });
  expect(translatorRequests[0]?.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
  expect(makeGeminiRequestBody({ prompt: "test", reasoningEffort: generatorConfig.reasoningEffort })
    .generationConfig.thinkingConfig.thinkingBudget).toBe(1024);
  expect(translatorConfig.reasoningEffort).toBe("none");
  expect(enrichedBody.item.senses[0].examples[0].translations).toEqual([
    { lang: "en", text: "We talked about 学校." },
    { lang: "zh-tw", text: "我們和老師談了這個詞。" },
    { lang: "zh-cn", text: "我们和老师谈了这个词。" }
  ]);

  const publicResult = await runtime.app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1");
  expect((await publicResult.json()).item.senses[0].examples[0].source).toBe("generated");
  expect(calls).toBe(3);
});

test("ordinary lookup is model-free and enrichment requires authentication", async () => {
  let calls = 0;
  const runtime = await setup(async () => {
    calls += 1;
    throw new Error("must not run");
  });
  expect((await runtime.app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1")).status).toBe(200);
  expect(calls).toBe(0);
  const denied = await runtime.app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1&enrich=true");
  expect(denied.status).toBe(401);
  expect(calls).toBe(0);
});

test("deterministic rejection is retried before the reviewer", async () => {
  const roles: string[] = [];
  const generatorPrompts: string[] = [];
  const runtime = await setup(async (input) => {
    roles.push(input.role);
    if (input.role === "generator") generatorPrompts.push(input.prompt);
    if (input.role === "generator" && roles.length === 1) {
      return '{"sentence":"短い。","english":"Short."}';
    }
    return validResponse(input.role, input.prompt);
  });
  const response = await authorised(runtime.app, "学校");
  expect(response.status).toBe(200);
  expect(roles).toEqual(["generator", "translator", "generator", "translator", "reviewer"]);
  expect(generatorPrompts[1]).toContain("deterministic_filter");
});

test("review rejection is fed into one retry, then dropped and recorded", async () => {
  const generatorPrompts: string[] = [];
  const runtime = await setup(async (input) => {
    if (input.role === "generator") {
      generatorPrompts.push(input.prompt);
      return validResponse(input.role, input.prompt);
    }
    if (input.role === "translator") return validResponse(input.role, input.prompt);
    const id = candidateId(input.prompt);
    return JSON.stringify({ id, decision: "reject", reason: "wrong_sense" });
  });
  const response = await authorised(runtime.app, "学校");
  const body = await response.json();
  expect(body.item.senses[0]).not.toHaveProperty("examples");
  const record = runtime.overlay.read(body.item.senses[0].id);
  expect(record?.status).toBe("dropped");
  expect(record?.attempts).toHaveLength(2);
  expect(generatorPrompts[1]).toContain("wrong_sense");

  await authorised(runtime.app, "学校");
  expect(generatorPrompts).toHaveLength(2);
});

test("abstention is recorded and not retried on later lookup", async () => {
  let calls = 0;
  const runtime = await setup(async () => {
    calls += 1;
    return '{"abstain":true,"reason":"archaic"}';
  });
  await authorised(runtime.app, "学校");
  await authorised(runtime.app, "学校");
  expect(calls).toBe(1);
  expect(runtime.overlay.accepted()).toEqual([]);
});

test("malformed output and timeout return the entry without failing the request", async () => {
  const malformedPrompts: string[] = [];
  const malformed = await setup(async (input) => {
    malformedPrompts.push(input.prompt);
    return "not json";
  });
  const malformedResponse = await authorised(malformed.app, "学校");
  expect(malformedResponse.status).toBe(200);
  const malformedBody = await malformedResponse.json();
  expect(malformedBody.item.senses[0]).not.toHaveProperty("examples");
  const malformedRecord = malformed.overlay.read(malformedBody.item.senses[0].id);
  expect(malformedRecord?.status).toBe("dropped");
  expect(malformedRecord?.attempts).toHaveLength(2);
  expect(malformedRecord?.reason).toBe("malformed_generator");
  expect(malformedPrompts).toHaveLength(2);
  expect(malformedPrompts[1]).toContain("malformed_generator");

  const timeout = await setup(() => new Promise<string>(() => {}), { timeoutMs: 5 });
  const timeoutResponse = await authorised(timeout.app, "学校");
  expect(timeoutResponse.status).toBe(200);
  const timeoutBody = await timeoutResponse.json();
  expect(timeoutBody.item.senses[0]).not.toHaveProperty("examples");
  const timeoutRecord = timeout.overlay.read(timeoutBody.item.senses[0].id);
  expect(timeoutRecord?.status).toBe("error");
  expect(timeoutRecord?.reason).toBe("generator_timeout");
  expect(timeoutRecord?.attempts[0].generator.provider).toBe("google");
  expect(timeoutRecord?.attempts[0].rejectionReason).toBe("generator_timeout");
});

test("translator timeout persists the generated candidate and remains retryable", async () => {
  let translatorCalls = 0;
  const runtime = await setup(async (input) => {
    if (input.role === "translator") {
      translatorCalls += 1;
      if (translatorCalls === 1) return new Promise<string>(() => {});
    }
    return validResponse(input.role, input.prompt);
  }, { timeoutMs: 5 });

  const first = await authorised(runtime.app, "学校");
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expect(firstBody.item.senses[0]).not.toHaveProperty("examples");
  const failed = runtime.overlay.read(firstBody.item.senses[0].id);
  expect(failed?.status).toBe("error");
  expect(failed?.reason).toBe("translator_timeout");
  expect(failed?.example?.translations).toEqual([{ lang: "en", text: "We talked about 学校." }]);
  expect(failed?.attempts[0].generator.provider).toBe("google");
  expect(failed?.attempts[0].translator?.reasoningEffort).toBe("none");
  expect(failed?.attempts[0].rejectionReason).toBe("translator_timeout");

  const retry = await authorised(runtime.app, "学校");
  expect((await retry.json()).item.senses[0].examples[0].source).toBe("generated");
  expect(runtime.overlay.read(firstBody.item.senses[0].id)?.attempts).toHaveLength(2);
  expect(translatorCalls).toBe(2);
});

test("malformed reviewer output retries once and records the terminal drop", async () => {
  const roles: string[] = [];
  const generatorPrompts: string[] = [];
  const runtime = await setup(async (input) => {
    roles.push(input.role);
    if (input.role === "generator") generatorPrompts.push(input.prompt);
    if (input.role === "reviewer") return "not json";
    return validResponse(input.role, input.prompt);
  });
  const response = await authorised(runtime.app, "学校");
  const body = await response.json();
  const record = runtime.overlay.read(body.item.senses[0].id);
  expect(response.status).toBe(200);
  expect(record?.status).toBe("dropped");
  expect(record?.attempts).toHaveLength(2);
  expect(record?.attempts.every((attempt) => attempt.reviewer?.provider === "anthropic")).toBe(true);
  expect(record?.reason).toBe("malformed_reviewer");
  expect(generatorPrompts[1]).toContain("malformed_reviewer");
  expect(roles).toEqual(["generator", "translator", "reviewer", "generator", "translator", "reviewer"]);
});

test("reviewer timeout persists full provenance and remains retryable", async () => {
  let reviewerCalls = 0;
  let totalCalls = 0;
  const runtime = await setup(async (input) => {
    totalCalls += 1;
    if (input.role === "reviewer") {
      reviewerCalls += 1;
      if (reviewerCalls === 1) return new Promise<string>(() => {});
    }
    return validResponse(input.role, input.prompt);
  }, { timeoutMs: 5 });

  const first = await authorised(runtime.app, "学校");
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expect(firstBody.item.senses[0]).not.toHaveProperty("examples");
  const failed = runtime.overlay.read(firstBody.item.senses[0].id);
  expect(failed?.status).toBe("error");
  expect(failed?.reason).toBe("reviewer_timeout");
  expect(failed?.example?.translations.map((item) => item.lang)).toEqual(["en", "zh-tw", "zh-cn"]);
  expect(failed?.attempts[0].generator.provider).toBe("google");
  expect(failed?.attempts[0].translator?.reasoningEffort).toBe("none");
  expect(failed?.attempts[0].reviewer?.provider).toBe("anthropic");

  const publicLookup = await runtime.app.request("/v1/lookup?q=%E5%AD%A6%E6%A0%A1");
  expect((await publicLookup.json()).item.senses[0]).not.toHaveProperty("examples");
  expect(totalCalls).toBe(3);

  const retry = await authorised(runtime.app, "学校");
  expect((await retry.json()).item.senses[0].examples[0].source).toBe("generated");
  const accepted = runtime.overlay.read(firstBody.item.senses[0].id);
  expect(accepted?.status).toBe("accepted");
  expect(accepted?.attempts).toHaveLength(2);
  expect(accepted?.attempts[0].rejectionReason).toBe("reviewer_timeout");
  expect(reviewerCalls).toBe(2);
});

test("many gaps have no enrichment cap and model concurrency stays bounded", async () => {
  let active = 0;
  let maxActive = 0;
  let generated = 0;
  const runtime = await setup(async (input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (input.role === "generator") generated += 1;
    await Bun.sleep(2);
    active -= 1;
    return validResponse(input.role, input.prompt);
  }, { concurrency: 3 });
  const response = await runtime.app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ queries: ["遇う", "学校", "暗い", "綺麗", "行く", "見せる", "読む", "高い"], enrich: true })
  });
  expect(response.status).toBe(200);
  expect(generated).toBe(8);
  expect(runtime.overlay.accepted()).toHaveLength(8);
  expect(maxActive).toBeLessThanOrEqual(3);
  expect(maxActive).toBeGreaterThan(1);
});

test("batch lookup accepts more than 100 queries without lifting model concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const runtime = await setup(async (input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(1);
    active -= 1;
    return validResponse(input.role, input.prompt);
  }, { concurrency: 2 });
  const queries = Array.from({ length: 101 }, () => "学校");
  const response = await runtime.app.request("/v1/lookup/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ queries, enrich: true })
  });
  expect(response.status).toBe(200);
  expect((await response.json()).results).toHaveLength(101);
  expect(maxActive).toBeLessThanOrEqual(2);
});

test("accepted overlay rows export and fold into a fresh data release database", async () => {
  const runtime = await setup(async (input) => validResponse(input.role, input.prompt));
  const enriched = await authorised(runtime.app, "学校");
  expect(enriched.status).toBe(200);

  const directory = resources.at(-1)!.directory;
  const overlayPath = join(directory, "missing", "overlay.sqlite");
  const sourcePath = join(directory, "generated.jsonl");
  const releaseDbPath = join(directory, "release.sqlite");
  await Bun.$`bun run scripts/export-example-overlay.ts --overlay ${overlayPath} --out ${sourcePath}`.quiet();
  const sourceRows = (await Bun.file(sourcePath).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(sourceRows).toHaveLength(1);
  expect(sourceRows[0].attempts[0].generator.provider).toBe("google");

  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --jlpt-vocab fixtures/jlpt-vocab --ai-examples ${sourcePath} --out ${releaseDbPath}`.quiet();
  const releaseDb = openLookupDb(releaseDbPath);
  try {
    expect(releaseDb.lookup("学校", "en").item?.senses[0].examples?.[0].source).toBe("generated");
  } finally {
    releaseDb.close();
  }
});

test("export preserves committed rows across empty and repeated overlays", async () => {
  const runtime = await setup(async (input) => validResponse(input.role, input.prompt));
  await authorised(runtime.app, "学校");
  const directory = resources.at(-1)!.directory;
  const sourcePath = join(directory, "generated.jsonl");
  const activeOverlayPath = join(directory, "missing", "overlay.sqlite");
  const emptyOverlayPath = join(directory, "empty", "overlay.sqlite");

  const current = runtime.overlay.accepted()[0]!;
  await Bun.write(sourcePath, `${JSON.stringify({
    senseId: current.senseId,
    example: { ...current.example, text: "古い例です。" },
    attempts: current.attempts
  })}\n`);

  await Bun.$`bun run scripts/export-example-overlay.ts --overlay ${activeOverlayPath} --out ${sourcePath}`.quiet();
  const first = await Bun.file(sourcePath).text();
  expect(first).not.toContain("古い例です。");
  await Bun.$`bun run scripts/export-example-overlay.ts --overlay ${activeOverlayPath} --out ${sourcePath}`.quiet();
  expect(await Bun.file(sourcePath).text()).toBe(first);
  await Bun.$`bun run scripts/export-example-overlay.ts --overlay ${emptyOverlayPath} --out ${sourcePath}`.quiet();
  expect(await Bun.file(sourcePath).text()).toBe(first);

  const releaseDbPath = join(directory, "preserved-release.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --ai-examples ${sourcePath} --out ${releaseDbPath}`.quiet();
  const releaseDb = openLookupDb(releaseDbPath);
  try {
    expect(releaseDb.lookup("学校", "en").item?.senses[0].examples?.[0].source).toBe("generated");
  } finally {
    releaseDb.close();
  }
});

async function setup(
  modelCall: ModelCall,
  options: { concurrency?: number; timeoutMs?: number } = {}
): Promise<{ app: ReturnType<typeof createApp>; overlay: ExampleOverlay }> {
  const directory = await mkdtemp(join(tmpdir(), "yori-enrichment-"));
  const dbPath = join(directory, "dict.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --jlpt-vocab fixtures/jlpt-vocab --out ${dbPath}`.quiet();
  const db = openLookupDb(dbPath);
  const overlay = openExampleOverlay(join(directory, "missing", "overlay.sqlite"));
  resources.push({ directory, db, overlay });
  const enrichment = createEnrichmentService({ overlay, modelCall, ...options });
  return {
    app: createApp(db, { enrichment, enrichmentToken: "test-token" }),
    overlay
  };
}

async function authorised(app: ReturnType<typeof createApp>, query: string): Promise<Response> {
  return app.request(`/v1/lookup?q=${encodeURIComponent(query)}&enrich=true`, {
    headers: { authorization: "Bearer test-token" }
  });
}

function validResponse(role: "generator" | "translator" | "reviewer", prompt: string): string {
  if (role === "reviewer") return JSON.stringify({ id: candidateId(prompt), decision: "accept" });
  if (role === "translator") return JSON.stringify({ translation: "我們和老師談了這個詞。" });
  const word = lineValue(prompt, "word");
  const reading = lineValue(prompt, "reading");
  const tags = JSON.parse(lineValue(prompt, "tags")) as string[];
  const target = tags.includes("uk") ? reading : word;
  return JSON.stringify({
    sentence: `${target}について先生と話しました。`,
    english: `We talked about ${word}.`
  });
}

function lineValue(prompt: string, key: string): string {
  return prompt.split("\n").find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? "";
}

function candidateId(prompt: string): string {
  return prompt.match(/\{"id":"([^"]+)"/)?.[1] ?? "";
}
