import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportOnDemandArtifacts } from "../src/on-demand-export";
import type { AttemptRecord } from "../src/on-demand-dictionary";
import type { PublicLookupItem } from "../src/types";

test("on-demand export is reproducible across JSONL, SQLite, and Yomitan v3", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-export-"));
  const entries = [generatedEntry()];
  const attempts = [attemptRecord()];
  const first = await exportOnDemandArtifacts(entries, attempts, join(root, "first"));
  const second = await exportOnDemandArtifacts(entries, attempts, join(root, "second"));

  expect(await bytes(first.jsonl)).toEqual(await bytes(second.jsonl));
  expect(await bytes(first.sqlite)).toEqual(await bytes(second.sqlite));
  expect(await bytes(first.yomitan)).toEqual(await bytes(second.yomitan));

  const row = JSON.parse((await Bun.file(first.jsonl).text()).trim());
  expect(row.entry.id).toBe("yori:e_generated_test");
  expect(row.provenance).toEqual([
    {
      promptVersion: "entry-author-v1",
      model: "gpt-5.6-luna",
      provider: "openai",
      reasoningEffort: "minimal"
    }
  ]);

  const db = new Database(first.sqlite, { readonly: true });
  expect(db.query<{ count: number }, []>("select count(*) as count from entries").get()?.count).toBe(1);
  expect(db.query<{ count: number }, []>("select count(*) as count from attempts").get()?.count).toBe(1);
  db.close();

  const index = JSON.parse(await Bun.$`unzip -p ${first.yomitan} index.json`.text());
  const terms = JSON.parse(await Bun.$`unzip -p ${first.yomitan} term_bank_1.json`.text());
  expect(index.format).toBe(3);
  expect(terms[0][0]).toBe("未知語");
  expect(terms[0][5]).toEqual(["unknown term"]);
});

test("export provenance is scoped to the entry and its senses", async () => {
  const first = generatedEntry();
  const second: PublicLookupItem = {
    ...generatedEntry(),
    id: "yori:e_generated_second",
    sourceId: "yori:e_generated_second",
    word: "第二語",
    senses: [{ ...generatedEntry().senses[0], id: "yori:s_generated_second" }]
  };
  const attempts = [
    { ...attemptRecord(), candidateId: first.id, model: "openai/gpt-5.6-luna" },
    { ...attemptRecord(), candidateId: second.id, model: "openai/gpt-5.7-luna" }
  ];
  const root = mkdtempSync(join(tmpdir(), "yori-export-provenance-"));
  const artifacts = await exportOnDemandArtifacts([first, second], attempts, root);
  const rows = (await Bun.file(artifacts.jsonl).text()).trim().split("\n").map((line) => JSON.parse(line));
  const byId = new Map(rows.map((row) => [row.entry.id, row.provenance]));

  expect(byId.get(first.id)).toEqual([expect.objectContaining({ model: "openai/gpt-5.6-luna" })]);
  expect(byId.get(second.id)).toEqual([expect.objectContaining({ model: "openai/gpt-5.7-luna" })]);
});

async function bytes(path: string): Promise<number[]> {
  return Array.from(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function generatedEntry(): PublicLookupItem {
  return {
    id: "yori:e_generated_test",
    word: "未知語",
    reading: "みちご",
    common: false,
    source: "generated",
    sourceId: "yori:e_generated_test",
    headwordLanguage: "ja",
    headwords: [{ text: "未知語", reading: "みちご", kind: "kanji", common: false, tags: [] }],
    senses: [
      {
        id: "yori:s_generated_test",
        position: 1,
        appliesTo: { kanji: ["*"], kana: ["*"] },
        partOfSpeech: ["n"],
        glosses: [
          { lang: "en", text: "unknown term", source: "generated", reviewStatus: "checked" },
          { lang: "zh-tw", text: "未知詞", source: "generated", reviewStatus: "checked" }
        ],
        provenance: "generated",
        evidenceIds: []
      }
    ]
  };
}

function attemptRecord(): AttemptRecord {
  return {
    candidateId: "yori:e_generated_test",
    role: "entry-author",
    promptVersion: "entry-author-v1",
    model: "gpt-5.6-luna",
    reasoningEffort: "minimal",
    provider: "openai",
    requestedServiceTier: "flex",
    effectiveServiceTier: "flex",
    requestId: "request-1",
    durationMs: 12,
    inputTokens: 10,
    outputTokens: 5,
    outcome: "candidate"
  };
}
