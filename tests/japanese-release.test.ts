import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLookupDb } from "../src/db";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { buildJapaneseRelease } from "../src/japanese-release";
import { migrateProductionDatabase } from "../src/production-database";
import type { PublicLookupItem } from "../src/types";

test("Japanese release snapshots all canonical entries without English runtime tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-release-"));
  const productionPath = join(root, "production.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${productionPath}`.quiet();
  migrateProductionDatabase(productionPath);
  const lookup = openLookupDb(productionPath);
  const repository = openEnrichmentRepository(productionPath, lookup);
  repository.saveEntry(generatedEntry());
  repository.close();
  lookup.close();

  const artifacts = await buildJapaneseRelease(productionPath, {
    outputDirectory: join(root, "release"),
    version: "test"
  });
  const rows = (await Bun.file(artifacts.jsonl).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(15);
  expect(rows.some((entry) => entry.word === "学校")).toBe(true);
  expect(rows.find((entry) => entry.word === "未知語")?.senses[0]).toMatchObject({
    provenance: "generated",
    glosses: expect.arrayContaining([
      expect.objectContaining({ lang: "en", text: "unknown term" }),
      expect.objectContaining({ lang: "zh-tw", text: "未知詞" })
    ])
  });

  const released = new Database(artifacts.sqlite, { readonly: true });
  expect(released.query<{ count: number }, []>("select count(*) as count from entries").get()?.count).toBe(15);
  expect(released.query<{ count: number }, []>(
    "select count(*) as count from sqlite_master where type = 'table' and name like 'english_%'"
  ).get()?.count).toBe(0);
  expect(released.query<{ count: number }, []>(
    "select count(*) as count from sqlite_master where type = 'table' and name = 'model_attempts'"
  ).get()?.count).toBe(0);
  released.close();
});

function generatedEntry(): PublicLookupItem {
  return {
    id: "yori:e_generated_release_test",
    word: "未知語",
    reading: "みちご",
    common: false,
    source: "generated",
    sourceId: "yori:e_generated_release_test",
    headwordLanguage: "ja",
    headwords: [{ text: "未知語", reading: "みちご", kind: "kanji", common: false, tags: [] }],
    senses: [{
      id: "yori:s_generated_release_test",
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [
        { lang: "en", text: "unknown term", source: "generated", reviewStatus: "checked" },
        { lang: "zh-tw", text: "未知詞", source: "generated", reviewStatus: "checked" }
      ],
      provenance: "generated",
      evidenceIds: []
    }]
  };
}
