import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOverlayLookupDb, openEnrichmentRepository } from "../src/enrichment-repository";
import type { AttemptRecord } from "../src/on-demand-dictionary";
import type { LookupDb } from "../src/db";
import type { PublicExample, PublicLookupItem } from "../src/types";

test("the enrichment repository persists entries, examples, and attempt records", () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-enrichment-")), "overlay.sqlite");
  const released = releasedEntry();
  const db = lookupDb(released);
  const first = openEnrichmentRepository(path, db);
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
  first.saveExample(released.senses[0].id, example);
  first.recordAttempt(attempt);
  first.close();

  const reopened = openEnrichmentRepository(path, db);
  expect(reopened.findOverlay("未知語", "ja")?.senses[0].examples).toEqual([example]);
  expect(reopened.findOverlay("学校", "ja")?.senses[0].examples).toEqual([example]);
  expect(reopened.acceptedEntries()).toEqual([
    { ...generated, senses: [{ ...generated.senses[0], examples: [example] }] }
  ]);
  expect(reopened.attemptRecords()).toEqual([attempt]);
  const publicLookup = createOverlayLookupDb(db, reopened);
  expect(publicLookup.lookup("未知語", "en").item?.senses[0].glosses).toEqual([
    { text: "unknown term", source: "generated", reviewStatus: "checked" }
  ]);
  reopened.close();
});

test("opening the new repository preserves accepted examples from the legacy overlay", () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-legacy-overlay-")), "overlay.sqlite");
  const example: PublicExample = {
    text: "学校へ行きます。",
    translations: [{ lang: "en", text: "I go to school." }],
    source: "generated",
    reviewStatus: "checked"
  };
  const legacy = new Database(path, { create: true });
  legacy.exec(`create table example_enrichments (
    sense_id text primary key,
    status text not null,
    example_json text,
    attempts_json text not null,
    reason text,
    updated_at text not null
  )`);
  legacy.prepare("insert into example_enrichments values (?, 'accepted', ?, '[]', null, ?)")
    .run(releasedEntry().senses[0].id, JSON.stringify(example), "2026-01-01T00:00:00.000Z");
  legacy.close();

  const repository = openEnrichmentRepository(path, lookupDb(releasedEntry()));
  expect(repository.findOverlay("学校", "ja")?.senses[0].examples).toEqual([example]);
  repository.close();
});

function lookupDb(item: PublicLookupItem): LookupDb {
  return {
    lookup(query) {
      return { item: query === item.word ? item : null };
    },
    meta() {
      return { apiVersion: "v1", dictionaryVersion: null, languages: [], tags: {}, sources: [] };
    },
    close() {}
  };
}

function releasedEntry(): PublicLookupItem {
  return {
    id: "yori:e_jmdict_1206730",
    word: "学校",
    reading: "がっこう",
    common: true,
    source: "jmdict",
    sourceId: "1206730",
    headwordLanguage: "ja",
    headwords: [{ text: "学校", reading: "がっこう", kind: "kanji", common: true, tags: [] }],
    senses: [
      {
        id: "yori:s_jmdict_1206730_1",
        position: 1,
        appliesTo: { kanji: ["*"], kana: ["*"] },
        partOfSpeech: ["n"],
        glosses: [{ text: "school", source: "jmdict", reviewStatus: "source" }]
      }
    ]
  };
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
