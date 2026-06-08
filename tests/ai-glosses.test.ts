import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { openLookupDb } from "../src/db";
import { candidateFromResponse, type AiSeed, type Candidate } from "../scripts/ai-common";

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
    candidateGlosses: ["處理！", "做嗎？"],
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
  expect(rejected[1].reasons).toContain("gloss contains sentence punctuation: 做嗎？");
  expect(rejected[2].reasons).toContain("Chinese gloss is too generic for this sense: 在");
});

test("normalizes ellipsis placeholders in accepted AI candidates", async () => {
  const dbPath = tempPath("ai-check-ellipsis.sqlite");
  const inputPath = tempPath("ai-candidates-ellipsis.jsonl");
  const acceptedPath = tempPath("ai-accepted-ellipsis.jsonl");
  const rejectedPath = tempPath("ai-rejected-ellipsis.jsonl");
  await Bun.$`rm -f ${dbPath} ${inputPath} ${acceptedPath} ${rejectedPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  const candidate: Candidate = {
    entryId: "yori:e_jmdict_1358280",
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    targetLang: "zh-tw",
    sourceGlosses: ["to eat"],
    candidateGlosses: ["對...來說", "對……而言"],
    model: "gemini-3-flash-preview",
    thinkingLevel: "low"
  };

  await Bun.write(inputPath, `${JSON.stringify(candidate)}\n`);
  await Bun.$`bun run scripts/check-ai-candidates.ts --db ${dbPath} --input ${inputPath} --out ${acceptedPath} --rejected ${rejectedPath}`;

  expect(await readJsonl(acceptedPath)).toEqual([
    {
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["對……來說", "對……而言"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }
  ]);
  expect(await readJsonl(rejectedPath)).toEqual([]);
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

test("reports AI gloss coverage", async () => {
  const dbPath = tempPath("ai-coverage.sqlite");
  const sourcePath = tempPath("ai-coverage-source.jsonl");
  await Bun.$`rm -f ${dbPath} ${sourcePath}`;
  await Bun.write(
    sourcePath,
    JSON.stringify({
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["吃"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }) + "\n"
  );
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath} --ai-glosses ${sourcePath}`;

  const result = await Bun.$`bun run scripts/report-ai-coverage.ts --db ${dbPath} --lang zh-tw --source ${sourcePath} --samples 2`.text();

  expect(result).toContain("lang: zh-tw");
  expect(result).toContain("coveredSenses: 1");
  expect(result).toContain("sourceRows: 1");
  expect(result).toContain("zh-tw sources:");
  expect(result).toContain("ai-assisted/checked: senses=1 glosses=1");
  expect(result).toContain("nextMissingSamples: 2");
});

test("exports AI gloss review bundles with JMdict context", async () => {
  const dbPath = tempPath("ai-review.sqlite");
  const sourcePath = tempPath("ai-review-source.jsonl");
  const outPath = tempPath("ai-review-bundle.jsonl");
  await Bun.$`rm -f ${dbPath} ${sourcePath} ${outPath}`;
  await Bun.write(
    sourcePath,
    JSON.stringify({
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["吃", "食用"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    }) + "\n"
  );
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath} --ai-glosses ${sourcePath}`;

  const result = await Bun.$`bun run scripts/review-ai-glosses.ts --db ${dbPath} --source ${sourcePath} --out ${outPath} --limit 10 --common-only`.text();
  const rows = await readJsonl(outPath);

  expect(result).toContain("Wrote 1 zh-tw review row(s)");
  expect(result).toContain("Claude review prompt:");
  expect(rows).toEqual([
    {
      senseId: "yori:s_jmdict_1358280_1",
      entryId: "yori:e_jmdict_1358280",
      word: "食べる",
      reading: "たべる",
      common: true,
      position: 1,
      pos: ["v1", "vt"],
      englishGlosses: ["to eat"],
      aiGlosses: ["吃", "食用"],
      ai: {
        lang: "zh-tw",
        model: "gemini-3-flash-preview"
      }
    }
  ]);
});

test("exports AI gloss review bundles with an offset", async () => {
  const dbPath = tempPath("ai-review-offset.sqlite");
  const sourcePath = tempPath("ai-review-offset-source.jsonl");
  const outPath = tempPath("ai-review-offset-bundle.jsonl");
  await Bun.$`rm -f ${dbPath} ${sourcePath} ${outPath}`;
  await Bun.write(
    sourcePath,
    [
      JSON.stringify({
        senseId: "yori:s_jmdict_1206730_1",
        lang: "zh-tw",
        glosses: ["學校"],
        source: "ai-assisted",
        model: "gemini-3-flash-preview"
      }),
      JSON.stringify({
        senseId: "yori:s_jmdict_1358280_1",
        lang: "zh-tw",
        glosses: ["吃"],
        source: "ai-assisted",
        model: "gemini-3-flash-preview"
      })
    ].join("\n") + "\n"
  );
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath} --ai-glosses ${sourcePath}`;

  const result = await Bun.$`bun run scripts/review-ai-glosses.ts --db ${dbPath} --source ${sourcePath} --out ${outPath} --limit 10 --offset 1 --common-only`.text();
  const rows = (await readJsonl(outPath)) as Array<{ senseId: string }>;

  expect(result).toContain("Skipped 1 eligible AI row(s) by offset");
  expect(rows.map((row) => row.senseId)).toEqual(["yori:s_jmdict_1358280_1"]);
});

test("exports AI gloss review bundles for non-common rows", async () => {
  const dbPath = tempPath("ai-review-non-common.sqlite");
  const sourcePath = tempPath("ai-review-non-common-source.jsonl");
  const outPath = tempPath("ai-review-non-common-bundle.jsonl");
  await Bun.$`rm -f ${dbPath} ${sourcePath} ${outPath}`;
  await Bun.write(
    sourcePath,
    [
      JSON.stringify({
        senseId: "yori:s_jmdict_1358280_1",
        lang: "zh-tw",
        glosses: ["吃"],
        source: "ai-assisted",
        model: "gemini-3-flash-preview"
      }),
      JSON.stringify({
        senseId: "yori:s_jmdict_1000300_1",
        lang: "zh-tw",
        glosses: ["處理"],
        source: "ai-assisted",
        model: "gemini-3-flash-preview"
      })
    ].join("\n") + "\n"
  );
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath} --ai-glosses ${sourcePath}`;

  const result = await Bun.$`bun run scripts/review-ai-glosses.ts --db ${dbPath} --source ${sourcePath} --out ${outPath} --limit 10 --non-common-only`.text();
  const rows = (await readJsonl(outPath)) as Array<{ senseId: string }>;

  expect(result).toContain("Skipped 1 common AI row(s)");
  expect(rows.map((row) => row.senseId)).toEqual(["yori:s_jmdict_1000300_1"]);
});

test("exports AI seeds while skipping rejected senses by default", async () => {
  const dbPath = tempPath("ai-export-skip.sqlite");
  const rejectedDir = tempPath("ai-export-rejected");
  const workDir = tempPath("ai-export-batches");
  const firstOutPath = tempPath("ai-export-first.jsonl");
  const skippedOutPath = tempPath("ai-export-skipped.jsonl");
  await Bun.$`rm -rf ${dbPath} ${rejectedDir} ${workDir} ${firstOutPath} ${skippedOutPath}`;
  await Bun.$`mkdir -p ${rejectedDir} ${workDir}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  await Bun.$`bun run scripts/export-ai-seeds.ts --db ${dbPath} --lang zh-tw --out ${firstOutPath} --limit 1 --rejected-dir ${rejectedDir} --work-dir ${workDir} --include-rejected`;
  const [firstSeed] = (await readJsonl(firstOutPath)) as Array<{ senseId: string }>;
  await Bun.write(
    `${rejectedDir}/zh-tw-rejected.jsonl`,
    `${JSON.stringify({
      senseId: firstSeed.senseId,
      candidate: { senseId: firstSeed.senseId, targetLang: "zh-tw" },
      reasons: ["test rejection"]
    })}\n`
  );

  const result = await Bun.$`bun run scripts/export-ai-seeds.ts --db ${dbPath} --lang zh-tw --out ${skippedOutPath} --limit 3 --rejected-dir ${rejectedDir} --work-dir ${workDir}`.text();
  const skippedSeeds = (await readJsonl(skippedOutPath)) as Array<{ senseId: string }>;

  expect(result).toContain("Skipped 1 previously rejected or failed sense(s)");
  expect(skippedSeeds.map((seed) => seed.senseId)).not.toContain(firstSeed.senseId);

  await Bun.$`bun run scripts/export-ai-seeds.ts --db ${dbPath} --lang zh-tw --out ${firstOutPath} --limit 1 --rejected-dir ${rejectedDir} --work-dir ${workDir} --include-rejected`;
  const [includedSeed] = (await readJsonl(firstOutPath)) as Array<{ senseId: string }>;
  expect(includedSeed.senseId).toBe(firstSeed.senseId);
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

test("summarizes an AI batch run", async () => {
  const runDir = tempPath("ai-summary-run");
  const manifestPath = `${runDir}/manifest.json`;
  const seedPath = `${runDir}/seeds.jsonl`;
  const candidatePath = `${runDir}/zh-tw-candidates.jsonl`;
  const rejectedPath = `${runDir}/zh-tw-rejected.jsonl`;
  const failuresPath = `${runDir}/failures.jsonl`;
  const sourcePath = `${runDir}/zh-tw-source.jsonl`;
  await Bun.$`rm -rf ${runDir}`;
  await Bun.$`mkdir -p ${runDir}`;

  await Bun.write(seedPath, `${JSON.stringify(aiSeed())}\n${JSON.stringify({ ...aiSeed(), senseId: "yori:s_jmdict_1206730_1" })}\n`);
  await Bun.write(candidatePath, `${JSON.stringify({ senseId: "yori:s_jmdict_1002400_4" })}\n`);
  await Bun.write(rejectedPath, `${JSON.stringify({ senseId: "yori:s_jmdict_1206730_1", reasons: ["bad"] })}\n`);
  await Bun.write(failuresPath, `${JSON.stringify({ key: "yori:s_jmdict_9999999_1", reason: "failed" })}\n`);
  await Bun.write(
    sourcePath,
    `${JSON.stringify({
      senseId: "yori:s_jmdict_1002400_4",
      lang: "zh-tw",
      glosses: ["您"],
      source: "ai-assisted",
      model: "gemini-3-flash-preview"
    })}\n`
  );
  await Bun.write(
    manifestPath,
    `${JSON.stringify({ seedPath, outPath: candidatePath, failuresPath })}\n`
  );

  const result = await Bun.$`bun run scripts/summarize-ai-batch.ts --manifest ${manifestPath} --source ${sourcePath} --rejected ${rejectedPath}`.text();

  expect(result).toContain("submitted: 2");
  expect(result).toContain("candidates: 1");
  expect(result).toContain("accepted: 1");
  expect(result).toContain("rejected: 1");
  expect(result).toContain("failed: 1");
  expect(result).toContain("sourceTotal: 1");
});

test("recovers gloss JSON from a response with trailing malformed text", () => {
  const seed = aiSeed();
  const candidate = candidateFromResponse(seed, "gemini-3-flash-preview", {
    candidates: [
      {
        content: {
          parts: [{ text: "{\"glosses\":[\"您\",\"閣下\"]}\n\"閣下\"]}" }]
        }
      }
    ]
  });

  expect(candidate.candidateGlosses).toEqual(["您", "閣下"]);
});

test("rejects unrecoverable gloss JSON", () => {
  expect(() =>
    candidateFromResponse(aiSeed(), "gemini-3-flash-preview", {
      candidates: [
        {
          content: {
            parts: [{ text: "{\"glosses\":[\"未完成\"" }]
          }
        }
      ]
    })
  ).toThrow("Unable to parse JSON string");
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

function aiSeed(): AiSeed {
  return {
    entryId: "yori:e_jmdict_1002400",
    senseId: "yori:s_jmdict_1002400_4",
    word: "お宅",
    reading: "おたく",
    common: true,
    position: 4,
    targetLang: "zh-tw",
    pos: ["pn"],
    glosses: ["you"]
  };
}
