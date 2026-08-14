import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLookupDb } from "../src/db";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { rebuildJapaneseDictionary } from "../src/japanese-rebuild";
import { migrateProductionDatabase } from "../src/production-database";
import type { PublicLookupItem } from "../src/types";

test("a rebuild gives every explanation language its own ordered senses", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "yori-ja-rebuild-")), "yori.sqlite");
  const result = await rebuildJapaneseDictionary({
    input: "fixtures/jmdict-sample.json",
    examples: "fixtures/jmdict-examples-sample.json",
    out
  });

  expect(result.coverage.en.entries).toBe(14);
  expect(result.coverage["zh-tw"]).toBeUndefined();

  const db = new Database(out, { readonly: true });
  // Every sense declares exactly one explanation language, and no gloss row
  // carries a language of its own that could disagree with it.
  expect(db.query<{ count: number }, []>("select count(*) as count from ja_senses where lang is null").get()?.count).toBe(0);
  expect(db.query<{ name: string }, []>("select name from pragma_table_info('ja_glosses') where name = 'lang'").all())
    .toEqual([]);

  // Each language numbers its senses from 1 inside that language, and English
  // keeps JMdict's full editorial order.
  expect(db.query<{ id: string; position: number }, []>(
    "select id, position from ja_senses where entry_id = 'yori:e_jmdict_1206730' order by lang, position"
  ).all()).toEqual([
    { id: "yori:s_jmdict_1206730_1:en", position: 1 }
  ]);
  // A source language Yori Dict has no grant for is unmapped, so the fixture's
  // German glosses on 学校 never become senses.
  expect(db.query<{ count: number }, []>("select count(*) as count from ja_senses where lang = 'de'").get()?.count).toBe(0);
  db.close();

  const lookup = openLookupDb(out);
  // `de` remains a valid explanation language with nothing behind it yet: a
  // gap Enrich-on-Lookup fills, not a language the API refuses.
  expect(lookup.lookup("学校", "de").item).toBeNull();
  expect(lookup.lookup("学校", "ko").item).toBeNull();
  expect(lookup.lookup("学校", "en").item?.senses[0].glosses.map((gloss) => gloss.text)).toEqual(["school"]);
  lookup.close();
});

test("a sourced example stays with the language its paired sentence is written in", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "yori-ja-example-")), "yori.sqlite");
  await rebuildJapaneseDictionary({
    input: "fixtures/jmdict-sample.json",
    examples: "fixtures/jmdict-examples-sample.json",
    out
  });

  const db = new Database(out, { readonly: true });
  const rows = db.query<{ lang: string; translations: string }, []>(`
    select sense.lang as lang, example.translations as translations
      from ja_examples example join ja_senses sense on sense.id = example.sense_id
  `).all();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(JSON.parse(row.translations).map((pair: { lang: string }) => pair.lang)).toEqual([row.lang]);
  }
  db.close();
});

test("legacy content becomes canonical only through an exact sense identifier", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-legacy-"));
  const glossPath = join(root, "zh-tw.jsonl");
  await writeFile(glossPath, [
    // Exact identifier of an imported sense: admitted as its own Taiwanese sense.
    JSON.stringify({ senseId: "yori:s_jmdict_1358280_1", lang: "zh-tw", glosses: ["吃"] }),
    // No such imported sense in the pinned source: never published.
    JSON.stringify({ senseId: "yori:s_jmdict_9999999_1", lang: "zh-tw", glosses: ["不存在"] })
  ].join("\n"));

  const out = join(root, "yori.sqlite");
  const result = await rebuildJapaneseDictionary({
    input: "fixtures/jmdict-sample.json",
    aiGlosses: [glossPath],
    out
  });
  expect(result.legacyGlosses).toEqual({ imported: 1, droppedUnknownSense: 1 });

  const lookup = openLookupDb(out);
  const taiwanese = lookup.lookup("食べる", "zh-tw").item;
  expect(taiwanese?.senses.map((sense) => sense.glosses[0].text)).toEqual(["吃"]);
  // The legacy sense is its own Taiwanese sense, not a gloss bolted onto
  // the English sense, and it keeps generated provenance.
  expect(taiwanese?.senses[0].id).toBe("yori:s_jmdict_1358280_1:zh-tw");
  expect(taiwanese?.senses[0].provenance).toBe("generated");
  expect(lookup.lookup("食べる", "en").item?.senses[0].glosses.map((gloss) => gloss.text)).toEqual(["to eat"]);
  lookup.close();

  const db = new Database(out, { readonly: true });
  expect(db.query<{ count: number }, []>("select count(*) as count from ja_senses where lang = 'zh-tw'").get()?.count).toBe(1);
  db.close();
});

test("a rebuild retains accepted generated content and does not reorder imported senses", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "yori-ja-retain-")), "yori.sqlite");
  await rebuildJapaneseDictionary({ input: "fixtures/jmdict-sample.json", out });
  migrateProductionDatabase(out);

  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  repository.saveEntry(generatedEntry(), "en", generation);
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
  const japaneseSenseId = "yori:s_generated_school:ja:1";
  repository.saveEntry({
    ...imported,
    senses: [{
      id: japaneseSenseId,
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang: "ja", text: "教育を行うための施設", source: "generated", reviewStatus: "checked" }],
      provenance: "generated",
      evidenceIds: []
    }]
  }, "ja", generation);
  repository.saveExample(japaneseSenseId, {
    text: "毎朝、学校へ行きます。",
    translations: [],
    source: "generated",
    reviewStatus: "checked"
  }, exampleGeneration);
  // An authored group written from licensed evidence carries source
  // provenance. It is still enrichment, and a rebuild must keep it.
  repository.saveEntry({
    ...imported,
    senses: [{
      id: "yori:s_sourced_school:ko:1",
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang: "ko", text: "학교", source: "jmdict", reviewStatus: "source" }],
      provenance: "source",
      evidenceIds: ["jmdict:1000001"]
    }]
  }, "ko", generation);
  const importedSenseId = imported.senses[0].id;
  repository.saveExample(importedSenseId, {
    text: "学校へ行きます。",
    translations: [{ lang: "en", text: "I go to school." }],
    source: "generated",
    reviewStatus: "checked"
  }, exampleGeneration);
  repository.close();
  lookup.close();

  const result = await rebuildJapaneseDictionary({ input: "fixtures/jmdict-sample.json", out });
  // Examples carried inside retained groups are counted with the group; the
  // standalone count is for generated Examples reattached to imported Senses.
  expect(result.retained).toEqual({ entries: 1, groups: 3, examples: 1 });

  const reopened = openLookupDb(out);
  const generated = reopened.lookup("未知語", "en").item;
  expect(generated?.source).toBe("generated");
  expect(generated?.senses[0].glosses[0].text).toBe("unknown term");
  // The accepted language group on an imported entry survived the rebuild with
  // its own provenance, and the imported English group came back from source.
  const taiwanese = reopened.lookup("学校", "zh-tw").item;
  expect(taiwanese?.id).toBe(reopened.lookup("学校", "en").item?.id);
  expect(taiwanese?.senses[0].glosses[0].text).toBe("學校");
  expect(taiwanese?.senses[0].provenance).toBe("generated");
  const japanese = reopened.lookup("学校", "ja").item;
  expect(japanese?.senses[0].glosses[0].text).toBe("教育を行うための施設");
  expect(japanese?.senses[0].examples?.[0]).toMatchObject({
    text: "毎朝、学校へ行きます。",
    translations: []
  });
  // The source-provenance authored group survived too: enrichment is marked by
  // its generation reference, not by every sense claiming to be generated.
  expect(reopened.lookup("学校", "ko").item?.senses[0].glosses[0].text).toBe("학교");
  expect(reopened.lookup("学校", "en").item?.senses[0].examples?.[0].text).toBe("学校へ行きます。");
  // A generated addition never renumbers imported senses.
  expect(reopened.lookup("食べる", "en").item?.senses[0].position).toBe(1);
  reopened.close();

  const db = new Database(out, { readonly: true });
  expect(db.query<{ prompt_version: string }, []>(
    "select distinct prompt_version from ja_generations order by prompt_version"
  ).all()).toEqual([{ prompt_version: "entry-author-v1" }, { prompt_version: "example-author-v1" }]);
  // Retained content never points at a generation row the rebuild left behind.
  for (const table of ["ja_senses", "ja_examples"]) {
    expect(db.query<{ count: number }, []>(`
      select count(*) as count from ${table}
       where generation_id is not null and generation_id not in (select id from ja_generations)
    `).get()?.count).toBe(0);
  }
  db.close();
});

test("a failed rebuild leaves the previous database usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-failure-"));
  const out = join(root, "yori.sqlite");
  await rebuildJapaneseDictionary({ input: "fixtures/jmdict-sample.json", out });

  const broken = join(root, "broken.json");
  await writeFile(broken, "{ not json");
  await expect(rebuildJapaneseDictionary({ input: broken, out })).rejects.toThrow();

  const lookup = openLookupDb(out);
  expect(lookup.lookup("学校", "en").item?.word).toBe("学校");
  lookup.close();
  expect((await Array.fromAsync(new Bun.Glob("*.tmp").scan({ cwd: root }))).length).toBe(0);
});

/** A later run of the same model: its own row, its own creation time. */
const exampleGeneration = {
  model: "gpt-5.6-luna",
  provider: "openrouter",
  reasoningEffort: "minimal",
  promptVersion: "example-author-v1",
  serviceTier: "flex",
  reviewOutcome: "accepted",
  createdAt: "2026-08-08T01:00:00.000Z"
};

const generation = {
  model: "gpt-5.6-luna",
  provider: "openrouter",
  reasoningEffort: "minimal",
  promptVersion: "entry-author-v1",
  serviceTier: "flex",
  reviewOutcome: "accepted",
  createdAt: "2026-08-08T00:00:00.000Z"
};

function generatedEntry(): PublicLookupItem {
  return {
    id: "yori:e_generated_rebuild_test",
    word: "未知語",
    reading: "みちご",
    common: false,
    source: "generated",
    sourceId: "yori:e_generated_rebuild_test",
    headwordLanguage: "ja",
    headwords: [{ text: "未知語", reading: "みちご", kind: "kanji", common: false, tags: [] }],
    senses: [{
      id: "yori:s_generated_rebuild_test:en:1",
      position: 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang: "en", text: "unknown term", source: "generated", reviewStatus: "checked" }],
      provenance: "generated",
      evidenceIds: []
    }]
  };
}

test("alternatives come from one match tier, never mixing a word with a guess about it", async () => {
  // した is a word, and it also deinflects to しる. Offering しる's entries
  // beside the word the reader actually wrote would bury it under a verb they
  // did not use. A lower tier is still consulted when the better one cannot
  // answer, which is the rule that was already here.
  const root = mkdtempSync(join(tmpdir(), "yori-ja-tier-"));
  const input = join(root, "jmdict.json");
  await Bun.write(input, JSON.stringify({
    words: [
      tierWord("3000001", "舌", "した", "tongue"),
      tierWord("3000002", "下", "した", "below"),
      tierWord("3000003", "知る", "しる", "to know")
    ]
  }));
  const out = join(root, "yori.sqlite");
  await rebuildJapaneseDictionary({ input, out });

  const lookup = openLookupDb(out);
  const exact = lookup.lookup("した", "en");
  // Both exact readings answer; the deinflected 知る does not join them.
  expect([exact.item!.word, ...exact.alternatives.map((item) => item.word)].sort()).toEqual(["下", "舌"]);
  expect(exact.alternatives.every((item) => item.inflectionPath === undefined)).toBe(true);

  // The lower tier is still reached when nothing matches the surface itself.
  const deinflected = lookup.lookup("しった", "en");
  expect(deinflected.item?.word).toBe("知る");
  expect(lookup.candidates?.("しった")[0]?.inflectionPath).toEqual(deinflected.item?.inflectionPath);
  lookup.close();
});

function tierWord(id: string, kanji: string, kana: string, gloss: string) {
  return {
    id,
    kanji: [{ text: kanji, common: true, tags: [] }],
    kana: [{ text: kana, common: true, tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: ["n"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: gloss }]
    }]
  };
}
