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

  await Bun.write(inputPath, `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`);
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
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reasons).toContain("Chinese gloss has no Han text: school");
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
