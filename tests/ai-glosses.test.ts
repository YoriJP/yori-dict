import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { openLookupDb } from "../src/db";
import type { Candidate } from "../scripts/ai-common";

test("imports accepted AI glosses into lookup responses", async () => {
  const dbPath = tempPath("ai-gloss-import.sqlite");
  const glossPath = tempPath("ai-gloss-source.jsonl");
  await Bun.$`rm -f ${dbPath} ${glossPath}`;
  await Bun.write(
    glossPath,
    JSON.stringify({
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["吃", "食用"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }) + "\n"
  );

  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath} --ai-glosses ${glossPath}`;

  const lookupDb = openLookupDb(dbPath);
  const app = createApp(lookupDb);
  const res = await app.request("/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%82%8B&lang=zh-tw");
  const body = await res.json();

  expect(body.item.senses[0].glosses).toEqual([
    { text: "吃", source: "ai-assisted", reviewStatus: "checked" },
    { text: "食用", source: "ai-assisted", reviewStatus: "checked" }
  ]);

  lookupDb.close();
});

test("filters AI candidates into accepted and rejected JSONL", async () => {
  const dbPath = tempPath("ai-check.sqlite");
  const inputPath = tempPath("ai-candidates.jsonl");
  const acceptedPath = tempPath("ai-accepted.jsonl");
  const rejectedPath = tempPath("ai-rejected.jsonl");
  await Bun.$`rm -f ${dbPath} ${inputPath} ${acceptedPath} ${rejectedPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  const good: Candidate = {
    entryId: "yori:e_jmdict_1358280",
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    targetLang: "zh-tw",
    sourceGlosses: ["to eat"],
    candidateGlosses: ["吃", "食用"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };
  const bad: Candidate = {
    entryId: "yori:e_jmdict_1206730",
    senseId: "yori:s_jmdict_1206730_1",
    word: "学校",
    reading: "がっこう",
    targetLang: "zh-tw",
    sourceGlosses: ["school"],
    candidateGlosses: ["school"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };
  const sentencePunctuation: Candidate = {
    entryId: "yori:e_jmdict_1000300",
    senseId: "yori:s_jmdict_1000300_1",
    word: "遇う",
    reading: "あしらう",
    targetLang: "zh-tw",
    sourceGlosses: ["to treat"],
    candidateGlosses: ["處理！", "...吧"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };
  const generic: Candidate = {
    entryId: "yori:e_jmdict_1358280",
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    targetLang: "zh-tw",
    sourceGlosses: ["to be (somewhere)"],
    candidateGlosses: ["在"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };

  await Bun.write(
    inputPath,
    [good, bad, sentencePunctuation, generic].map((candidate) => JSON.stringify(candidate)).join("\n") + "\n"
  );
  await Bun.$`bun run scripts/check-ai-candidates.ts --db ${dbPath} --input ${inputPath} --out ${acceptedPath} --rejected ${rejectedPath}`;

  const accepted = await readJsonl(acceptedPath);
  const rejected = (await readJsonl(rejectedPath)) as Array<{ reasons: string[] }>;

  expect(accepted).toEqual([
    {
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["吃", "食用"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }
  ]);
  expect(rejected).toHaveLength(3);
  expect(rejected[0].reasons).toContain("Chinese gloss has no Han text: school");
  expect(rejected[1].reasons).toContain("gloss contains sentence punctuation: 處理！");
  expect(rejected[1].reasons).toContain("gloss contains sentence punctuation: ...吧");
  expect(rejected[2].reasons).toContain("Chinese gloss is too generic for this sense: 在");
});

test("appends accepted AI candidates without duplicating existing source rows", async () => {
  const dbPath = tempPath("ai-check-append.sqlite");
  const inputPath = tempPath("ai-candidates-append.jsonl");
  const acceptedPath = tempPath("ai-accepted-append.jsonl");
  const rejectedPath = tempPath("ai-rejected-append.jsonl");
  await Bun.$`rm -f ${dbPath} ${inputPath} ${acceptedPath} ${rejectedPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  await Bun.write(
    acceptedPath,
    JSON.stringify({
      senseId: "yori:s_jmdict_1206730_1",
      lang: "zh-tw",
      glosses: ["學校"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }) + "\n"
  );

  const duplicateExisting: Candidate = {
    entryId: "yori:e_jmdict_1206730",
    senseId: "yori:s_jmdict_1206730_1",
    word: "学校",
    reading: "がっこう",
    targetLang: "zh-tw",
    sourceGlosses: ["school"],
    candidateGlosses: ["學校"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };
  const newCandidate: Candidate = {
    entryId: "yori:e_jmdict_1358280",
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    targetLang: "zh-tw",
    sourceGlosses: ["to eat"],
    candidateGlosses: ["吃"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };

  await Bun.write(inputPath, `${JSON.stringify(duplicateExisting)}\n${JSON.stringify(newCandidate)}\n`);
  await Bun.$`bun run scripts/check-ai-candidates.ts --db ${dbPath} --input ${inputPath} --out ${acceptedPath} --rejected ${rejectedPath} --append`;

  const accepted = await readJsonl(acceptedPath);
  const rejected = (await readJsonl(rejectedPath)) as Array<{ reasons: string[] }>;

  expect(accepted).toHaveLength(2);
  expect(accepted).toContainEqual({
    senseId: "yori:s_jmdict_1206730_1",
    lang: "zh-tw",
    glosses: ["學校"],
    source: "ai-assisted",
    model: "gemini-3-flash-preview"
  });
  expect(accepted).toContainEqual({
    senseId: "yori:s_jmdict_1358280_1",
    lang: "zh-tw",
    glosses: ["吃"],
    source: "ai-assisted",
    model: "gemini-3-flash-preview"
  });
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reasons).toContain(
    "duplicate candidate or existing source row for yori:s_jmdict_1206730_1:zh-tw"
  );
});

test("validates accepted AI gloss source files", async () => {
  const dbPath = tempPath("ai-validate.sqlite");
  const validPath = tempPath("ai-valid-source.jsonl");
  const invalidPath = tempPath("ai-invalid-source.jsonl");
  await Bun.$`rm -f ${dbPath} ${validPath} ${invalidPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  const validRow = {
    senseId: "yori:s_jmdict_1358280_1",
    lang: "zh-tw",
    glosses: ["吃"],
    source: "ai-assisted",
    model: "gemini-3-flash-preview"
  };
  await Bun.write(validPath, `${JSON.stringify(validRow)}\n`);
  await Bun.$`bun run scripts/validate-ai-glosses.ts --db ${dbPath} --input ${validPath}`;

  await Bun.write(invalidPath, `${JSON.stringify(validRow)}\n${JSON.stringify({ ...validRow, glosses: ["eat"] })}\n`);
  const result = await Bun.$`bun run scripts/validate-ai-glosses.ts --db ${dbPath} --input ${invalidPath}`.nothrow();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("duplicate source row for yori:s_jmdict_1358280_1:zh-tw");
  expect(result.stderr.toString()).toContain("Chinese gloss has no Han text: eat");
});

test("exports failed batch seeds from a manifest", async () => {
  const runDir = tempPath("ai-failed-run");
  const manifestPath = `${runDir}/manifest.json`;
  const seedPath = `${runDir}/seeds.jsonl`;
  const failuresPath = `${runDir}/failures.jsonl`;
  const outPath = `${runDir}/failed-seeds.jsonl`;
  await Bun.$`rm -rf ${runDir}`;
  await Bun.$`mkdir -p ${runDir}`;

  const seedA = {
    entryId: "yori:e_jmdict_1358280",
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    common: true,
    position: 1,
    targetLang: "zh-tw",
    pos: ["v1", "vt"],
    glosses: ["to eat"]
  };
  const seedB = {
    ...seedA,
    entryId: "yori:e_jmdict_1206730",
    senseId: "yori:s_jmdict_1206730_1",
    word: "学校",
    reading: "がっこう",
    pos: ["n"],
    glosses: ["school"]
  };

  await Bun.write(seedPath, `${JSON.stringify(seedA)}\n${JSON.stringify(seedB)}\n`);
  await Bun.write(
    failuresPath,
    `${JSON.stringify({ key: seedB.senseId, reason: "JSON Parse error" })}\n${JSON.stringify({ key: seedB.senseId, reason: "duplicate" })}\n`
  );
  await Bun.write(manifestPath, `${JSON.stringify({ seedPath, failuresPath })}\n`);

  await Bun.$`bun run scripts/export-failed-ai-seeds.ts --manifest ${manifestPath} --out ${outPath}`;

  expect(await readJsonl(outPath)).toEqual([seedB]);
});

function tempPath(name: string): string {
  return `/tmp/yori-dict-api-${process.pid}-${name}`;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
