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

  first.saveEntry(englishGroup(generated), "en", generation);
  first.saveEntry(taiwaneseGroup(generated), "zh-tw", generation);
  first.saveExample(englishGroup(generated).senses[0].id, example, generation);
  const releasedSenseId = first.find("学校", "ja", "en")!.senses[0].id;
  first.saveExample(releasedSenseId, example, generation);
  first.recordAttempt(attempt);
  first.close();
  firstLookup.close();

  const reopenedLookup = openLookupDb(path);
  const reopened = openEnrichmentRepository(path, reopenedLookup);
  expect(reopened.find("未知語", "ja", "en")?.senses[0].examples).toEqual([example]);
  expect(reopened.find("学校", "ja", "en")?.senses[0].examples).toEqual([example]);
  // Each explanation language keeps its own meaning list for the same entry.
  expect(reopened.find("未知語", "ja", "zh-tw")?.senses.map((sense) => sense.glosses[0].text))
    .toEqual(["未知詞"]);
  expect(reopened.find("未知語", "ja", "ko")).toBeNull();
  expect(reopened.acceptedEntries("en").map((entry) => entry.word)).toEqual(["未知語"]);
  expect(reopened.attemptRecords()).toEqual([attempt]);

  // Full generation provenance stays in canonical storage.
  const generations = new Database(path, { readonly: true });
  expect(generations.query<{ model: string; prompt_version: string; review_outcome: string }, []>(
    "select model, prompt_version, review_outcome from ja_generations"
  ).all()).toEqual([
    { model: "gpt-5.6-luna", prompt_version: "entry-author-v1", review_outcome: "accepted" }
  ]);
  generations.close();
  reopened.close();
  reopenedLookup.close();
});

test("each explanation language keeps its own accepted group", async () => {
  const path = await productionDatabase();
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const generated = generatedEntry();

  repository.saveEntry(englishGroup(generated), "en", generation);
  repository.saveEntry(taiwaneseGroup(generated), "zh-tw", generation);
  repository.close();

  const reopened = openLookupDb(path);
  expect(reopened.lookup("未知語", "en").item?.senses[0].glosses[0].text).toBe("unknown term");
  expect(reopened.lookup("未知語", "zh-tw").item?.senses[0].glosses[0].text).toBe("未知詞");
  reopened.close();
  lookup.close();
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
  repository.saveEntry(englishGroup(generatedEntry()), "en", generation);
  // The usual shape of accepted enrichment: a whole language group authored
  // for an entry the pinned source provides.
  const imported = repository.find("学校", "ja", "en")!;
  repository.saveEntry({
    ...imported,
    senses: [{
      id: "yori:s_generated_school:zh-tw:1",
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang: "zh-tw", text: "學校", source: "generated", reviewStatus: "checked" }],
      provenance: "generated",
      evidenceIds: []
    }]
  }, "zh-tw", generation);
  repository.saveExample(imported.senses[0].id, example, generation);
  repository.close();
  lookup.close();

  const next = join(mkdtempSync(join(tmpdir(), "yori-next-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const candidate = new Database(next);
  candidate.prepare("update ja_metadata set value = 'next' where key = 'dictDate'").run();
  candidate.close();
  expect(importJapaneseRelease(path, next)).toBe(true);

  const refreshedLookup = openLookupDb(path);
  expect(refreshedLookup.lookup("未知語", "en").item?.word).toBe("未知語");
  expect(refreshedLookup.lookup("学校", "en").item?.senses[0].examples).toEqual([example]);
  // The accepted language group on an imported entry survived the refresh with
  // its own provenance, under that entry's own identity.
  const taiwanese = refreshedLookup.lookup("学校", "zh-tw").item;
  expect(taiwanese?.id).toBe(refreshedLookup.lookup("学校", "en").item?.id);
  expect(taiwanese?.senses[0].glosses[0].text).toBe("學校");
  expect(taiwanese?.senses[0].provenance).toBe("generated");
  refreshedLookup.close();
});

test("a generated example is appended after the imported examples of its meaning", async () => {
  const path = await productionDatabase({ examples: true });
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const imported = lookup.lookup("食べる", "en").item!.senses[0];
  expect(imported.examples?.[0]?.source).toBe("sourced");

  const generated: PublicExample = {
    text: "毎日果物を食べる。",
    translations: [{ lang: "en", text: "I eat fruit every day." }],
    source: "generated",
    reviewStatus: "checked"
  };
  repository.saveExample(imported.id, generated, generation);
  repository.close();

  const reopened = openLookupDb(path);
  // The imported example keeps its source position; the generated one follows.
  expect(reopened.lookup("食べる", "en").item?.senses[0].examples)
    .toEqual([...imported.examples!, generated]);
  reopened.close();
  lookup.close();
});

test("an absorbed legacy language group joins the entry it explains", async () => {
  const path = await productionDatabase();
  const legacyPath = join(mkdtempSync(join(tmpdir(), "yori-legacy-group-")), "entry-overlay.sqlite");
  const legacy = new Database(legacyPath);
  legacy.exec("create table on_demand_entries (entry_id text primary key, entry_json text not null)");
  const schoolEntry: PublicLookupItem = {
    ...generatedEntry(),
    id: "yori:e_generated_legacy_school",
    word: "学校",
    reading: "がっこう",
    sourceId: "yori:e_generated_legacy_school",
    headwords: [{ text: "学校", reading: "がっこう", kind: "kanji", common: false, tags: [] }],
    senses: [{
      ...generatedEntry().senses[0],
      id: "yori:s_generated_legacy_school",
      glosses: [{ lang: "zh-tw", text: "學校", source: "generated", reviewStatus: "checked" }]
    }]
  };
  legacy.prepare("insert into on_demand_entries values (?, ?)").run(schoolEntry.id, JSON.stringify(schoolEntry));
  legacy.close();

  expect(importLegacyOverlays(path, legacyPath, join(dirname(legacyPath), "missing.sqlite")).japanese).toBe(true);
  const reopened = openLookupDb(path);
  const english = reopened.lookup("学校", "en").item!;
  const taiwanese = reopened.lookup("学校", "zh-tw").item!;
  // One entry with two sibling language groups, not two entries sharing a term.
  expect(taiwanese.id).toBe(english.id);
  expect(taiwanese.senses[0].glosses[0].text).toBe("學校");
  // The imported English group was not replaced by the absorbed record.
  expect(english.senses[0].glosses[0].text).toBe("school");
  reopened.close();
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

async function productionDatabase(options: { examples?: boolean } = {}): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "yori-production-")), "yori.sqlite");
  const examples = options.examples ? ["--examples", "fixtures/jmdict-examples-sample.json"] : [];
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json ${{ raw: examples.join(" ") }} --out ${path}`.quiet();
  migrateProductionDatabase(path);
  return path;
}

test("a Japanese release that starts carrying an authored headword takes over its entry", async () => {
  const path = await productionDatabase();
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  // Authored before any source carried the word, so its id is its own and can
  // never equal the JMdict id the release will bring.
  const authored: PublicLookupItem = {
    ...generatedEntry(),
    id: "yori:e_generated_school",
    word: "学校",
    reading: "がっこう",
    sourceId: "yori:e_generated_school",
    headwords: [{ text: "学校", reading: "がっこう", kind: "kanji", common: false, tags: [] }]
  };
  repository.saveEntry(englishGroup(authored), "en", generation);
  repository.saveEntry({
    ...authored,
    senses: [{
      id: "yori:s_generated_school:zh-tw:1",
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang: "zh-tw", text: "學校", source: "generated", reviewStatus: "checked" }],
      provenance: "generated",
      evidenceIds: []
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  const next = join(mkdtempSync(join(tmpdir(), "yori-takeover-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const candidate = new Database(next);
  candidate.prepare("update ja_metadata set value = 'next' where key = 'dictDate'").run();
  candidate.close();
  expect(importJapaneseRelease(path, next)).toBe(true);

  const db = new Database(path, { readonly: true });
  // One entry for the word, owned by the release. A surviving authored row
  // would keep answering lookups with its own stale meanings.
  expect(db.query<{ id: string; source: string }, []>(`
    select distinct entry.id, entry.source from ja_entries entry
      join ja_lookup_terms term on term.entry_id = entry.id
     where term.term = '学校'
  `).all()).toEqual([{ id: "yori:e_jmdict_1206730", source: "jmdict" }]);
  db.close();

  const refreshed = openLookupDb(path);
  expect(refreshed.lookup("学校", "en").item?.senses[0].glosses[0].text).toBe("school");
  // The accepted group moved onto the entry the release now provides.
  const taiwanese = refreshed.lookup("学校", "zh-tw").item;
  expect(taiwanese?.id).toBe("yori:e_jmdict_1206730");
  expect(taiwanese?.senses[0].glosses[0].text).toBe("學校");
  refreshed.close();
});

const generation = {
  model: "gpt-5.6-luna",
  provider: "openrouter",
  reasoningEffort: "minimal",
  promptVersion: "entry-author-v1",
  serviceTier: "flex",
  reviewOutcome: "accepted",
  createdAt: "2026-08-08T00:00:00.000Z"
};

/** One entry-language group: only this language's meanings and glosses. */
function languageGroup(entry: PublicLookupItem, lang: "en" | "zh-tw"): PublicLookupItem {
  return {
    ...entry,
    senses: entry.senses.flatMap((sense) => {
      const glosses = sense.glosses.filter((gloss) => gloss.lang === lang);
      return glosses.length === 0 ? [] : [{ ...sense, id: `${sense.id}:${lang}`, glosses }];
    })
  };
}

function englishGroup(entry: PublicLookupItem): PublicLookupItem {
  return languageGroup(entry, "en");
}

function taiwaneseGroup(entry: PublicLookupItem): PublicLookupItem {
  return languageGroup(entry, "zh-tw");
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
