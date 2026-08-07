import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { importLegacyOverlays } from "../src/legacy-overlay-import";
import { openLookupDb } from "../src/db";
import { importJapaneseRelease, migrateProductionDatabase } from "../src/production-database";
import type { AttemptRecord } from "../src/on-demand-dictionary";
import type { PublicExample, PublicLookupItem } from "../src/types";

test("accepted Japanese enrichment becomes canonical production data", async () => {
  const path = await productionDatabase();
  const firstLookup = openLookupDb(path);
  const first = openEnrichmentRepository(path, firstLookup);
  const generated = generatedEntry();
  const example: PublicExample = {
    text: "この未知語の意味を調べた。",
    translations: [{ lang: "en", text: "I looked up this unknown term." }],
    source: "generated",
    reviewStatus: "checked"
  };
  const attempt: AttemptRecord = {
    candidateId: generated.id,
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

  first.saveEntry(generated);
  first.saveExample(generated.senses[0].id, example);
  const releasedSenseId = first.find("学校", "ja")!.senses[0].id;
  first.saveExample(releasedSenseId, example);
  first.recordAttempt(attempt);
  first.close();
  firstLookup.close();

  const reopenedLookup = openLookupDb(path);
  const reopened = openEnrichmentRepository(path, reopenedLookup);
  expect(reopened.find("未知語", "ja")?.senses[0].examples).toEqual([example]);
  expect(reopened.find("学校", "ja")?.senses[0].examples).toEqual([example]);
  expect(reopened.acceptedEntries()).toEqual([
    { ...generated, senses: [{ ...generated.senses[0], examples: [example] }] }
  ]);
  expect(reopened.attemptRecords()).toEqual([attempt]);
  reopened.close();
  reopenedLookup.close();
});

test("production migrations are idempotent", async () => {
  const path = await productionDatabase();
  migrateProductionDatabase(path);
  migrateProductionDatabase(path);
  const lookup = openLookupDb(path);
  expect(lookup.lookup("学校", "en").item?.word).toBe("学校");
  lookup.close();
});

test("a Japanese source refresh preserves accepted generated content", async () => {
  const path = await productionDatabase();
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const example: PublicExample = {
    text: "学校へ行きます。",
    translations: [{ lang: "en", text: "I go to school." }],
    source: "generated",
    reviewStatus: "checked"
  };
  repository.saveEntry(generatedEntry());
  repository.saveExample(repository.find("学校", "ja")!.senses[0].id, example);
  repository.close();
  lookup.close();

  const next = join(mkdtempSync(join(tmpdir(), "yori-next-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const candidate = new Database(next);
  candidate.prepare("update metadata set value = 'next' where key = 'dictDate'").run();
  candidate.close();
  expect(importJapaneseRelease(path, next)).toBe(true);

  const refreshedLookup = openLookupDb(path);
  expect(refreshedLookup.lookup("未知語", "en").item?.word).toBe("未知語");
  expect(refreshedLookup.lookup("学校", "en").item?.senses[0].examples).toEqual([example]);
  refreshedLookup.close();
});

test("legacy overlays are absorbed once into canonical production data", async () => {
  const path = await productionDatabase();
  const legacyPath = join(mkdtempSync(join(tmpdir(), "yori-legacy-overlay-")), "example-overlay.sqlite");
  const legacy = new Database(legacyPath);
  legacy.exec(`create table example_enrichments (
    sense_id text primary key, status text not null, example_json text,
    attempts_json text not null, reason text, updated_at text not null
  )`);
  const lookup = openLookupDb(path);
  const senseId = lookup.lookup("学校", "en").item!.senses[0].id;
  lookup.close();
  const example: PublicExample = {
    text: "学校へ行きます。",
    translations: [{ lang: "en", text: "I go to school." }],
    source: "generated",
    reviewStatus: "checked"
  };
  legacy.prepare("insert into example_enrichments values (?, 'accepted', ?, '[]', null, ?)")
    .run(senseId, JSON.stringify(example), "2026-08-01T00:00:00.000Z");
  legacy.close();

  expect(importLegacyOverlays(path, legacyPath, join(dirname(legacyPath), "missing.sqlite")).japanese).toBe(true);
  expect(importLegacyOverlays(path, legacyPath, join(dirname(legacyPath), "missing.sqlite")).japanese).toBe(false);
  const reopened = openLookupDb(path);
  expect(reopened.lookup("学校", "en").item?.senses[0].examples).toEqual([example]);
  reopened.close();
});

async function productionDatabase(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "yori-production-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${path}`.quiet();
  migrateProductionDatabase(path);
  return path;
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
