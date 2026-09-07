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

test("a rebuild records the exact source Evidence missing from a retained language group", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-gaps-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const sense = (text: string) => ({
    partOfSpeech: ["n"],
    appliesToKanji: ["*"],
    appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  await writeFile(input, JSON.stringify({
    version: "fixture-v1",
    dictDate: "2026-09-06",
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: [
        sense("state or appearance"),
        sense("way or manner"),
        sense("situation"),
        sense("honorific title")
      ]
    }]
  }));
  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1",
    lang: "zh-tw",
    glosses: ["樣子"]
  }));

  const out = join(root, "yori.sqlite");
  const result = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });

  expect(result.coverageGaps).toEqual({
    summary: { "zh-tw": { groups: 1, missingEvidenceIds: 3 } },
    details: [
      {
        entryId: "yori:e_jmdict_1410750",
        lang: "zh-tw",
        missingEvidenceId: "jmdict:1410750:2",
        sourceVersion: "fixture-v1",
        basis: "legacy-exact-sense-mapping"
      },
      {
        entryId: "yori:e_jmdict_1410750",
        lang: "zh-tw",
        missingEvidenceId: "jmdict:1410750:3",
        sourceVersion: "fixture-v1",
        basis: "legacy-exact-sense-mapping"
      },
      {
        entryId: "yori:e_jmdict_1410750",
        lang: "zh-tw",
        missingEvidenceId: "jmdict:1410750:4",
        sourceVersion: "fixture-v1",
        basis: "legacy-exact-sense-mapping"
      }
    ]
  });
});

test("a rebuild recovers legacy source_ref Evidence after a structure-only migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-migrated-evidence-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const out = join(root, "yori.sqlite");
  const sense = (text: string) => ({
    partOfSpeech: ["n"], appliesToKanji: ["*"], appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  await writeFile(input, JSON.stringify({
    version: "fixture-v1",
    dictDate: "fixture-v1",
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: [sense("appearance"), sense("manner")]
    }]
  }));
  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1", lang: "zh-tw", glosses: ["舊的部分解釋"]
  }));
  await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  migrateProductionDatabase(out);

  const migrated = new Database(out);
  migrated.prepare(`
    delete from ja_sense_evidence
     where sense_id = 'yori:s_jmdict_1410750_1:zh-tw'
  `).run();
  migrated.prepare("update ja_metadata set value = 'ja-2' where key = 'schemaVersion'").run();
  migrated.close();

  const result = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  expect(result.coverageGaps.details.map((gap) => gap.missingEvidenceId)).toEqual([
    "jmdict:1410750:2"
  ]);
  const rebuilt = openLookupDb(out);
  expect(rebuilt.lookup("様", "zh-tw").item?.senses[0]?.evidenceIds).toEqual([
    "jmdict:1410750:1"
  ]);
  rebuilt.close();
});

test("an evidence-free retained group cannot displace a newly proven partial group", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-unknown-retain-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const out = join(root, "yori.sqlite");
  const sense = (text: string) => ({
    partOfSpeech: ["n"], appliesToKanji: ["*"], appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  await writeFile(input, JSON.stringify({
    version: "fixture-v1",
    dictDate: "fixture-v1",
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: [sense("appearance"), sense("manner")]
    }]
  }));
  await rebuildJapaneseDictionary({ input, out });
  migrateProductionDatabase(out);

  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  const imported = repository.find("様", "ja", "en")!;
  repository.saveEntry({
    ...imported,
    senses: [{
      ...imported.senses[0]!,
      id: "yori:s_unknown_1410750:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "沒有來源證據的解釋", source: "generated", reviewStatus: "checked" }],
      evidenceIds: [],
      provenance: "generated"
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1", lang: "zh-tw", glosses: ["樣子"]
  }));
  const rebuilt = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  const reopened = openLookupDb(out);
  expect(reopened.lookup("様", "zh-tw").item?.senses[0]?.glosses[0]?.text).toBe("樣子");
  reopened.close();
  expect(rebuilt.coverageGaps.details.map((gap) => gap.missingEvidenceId)).toEqual([
    "jmdict:1410750:2"
  ]);
});

test("a poorer retained group cannot displace richer same-version imported coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-richer-import-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const out = join(root, "yori.sqlite");
  const sense = (text: string) => ({
    partOfSpeech: ["n"], appliesToKanji: ["*"], appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  await writeFile(input, JSON.stringify({
    version: "fixture-v1",
    dictDate: "fixture-v1",
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: [sense("appearance"), sense("manner"), sense("situation")]
    }]
  }));
  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1", lang: "zh-tw", glosses: ["古い第一義"]
  }));
  await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  migrateProductionDatabase(out);

  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  const partial = repository.find("様", "ja", "zh-tw")!;
  repository.saveEntry({
    ...partial,
    senses: [{
      ...partial.senses[0]!,
      id: "yori:s_poorer_retained_1410750:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "保留された第一義", source: "generated", reviewStatus: "checked" }],
      evidenceIds: ["jmdict:1410750:1"],
      provenance: "source"
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  await writeFile(glossPath, ["新しい第一義", "新しい第二義"].map((gloss, index) => JSON.stringify({
    senseId: `yori:s_jmdict_1410750_${index + 1}`,
    lang: "zh-tw",
    glosses: [gloss]
  })).join("\n"));
  const rebuilt = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  const reopened = openLookupDb(out);
  expect(reopened.lookup("様", "zh-tw").item?.senses.map((item) => item.glosses[0]?.text))
    .toEqual(["新しい第一義", "新しい第二義"]);
  reopened.close();
  expect(rebuilt.coverageGaps.details.map((gap) => gap.missingEvidenceId)).toEqual([
    "jmdict:1410750:3"
  ]);
});

test("unrelated retained Evidence remains Unknown Coverage", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "yori-ja-unrelated-evidence-")), "yori.sqlite");
  await rebuildJapaneseDictionary({ input: "fixtures/jmdict-sample.json", out });
  migrateProductionDatabase(out);
  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  const imported = repository.find("学校", "ja", "en")!;
  repository.saveEntry({
    ...imported,
    senses: [{
      ...imported.senses[0]!,
      id: "yori:s_unrelated_evidence_school:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "學校", source: "generated", reviewStatus: "checked" }],
      evidenceIds: ["japanese-wordnet:01930874-v"],
      provenance: "source"
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  const rebuilt = await rebuildJapaneseDictionary({ input: "fixtures/jmdict-sample.json", out });
  expect(rebuilt.coverageGaps.details.some(
    (gap) => gap.entryId === "yori:e_jmdict_1206730" && gap.lang === "zh-tw"
  )).toBe(false);
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
  // An absent group has no coverage claim, while an authored group without
  // reconstructable Evidence remains readable as Unknown Coverage. Neither is
  // recorded as a Proven Coverage Gap.
  expect(result.coverage.de).toBeUndefined();
  expect(result.coverageGaps.details.some((gap) => gap.lang === "de")).toBe(false);
  expect(result.coverageGaps.details.some(
    (gap) => gap.entryId === "yori:e_jmdict_1206730" && gap.lang === "zh-tw"
  )).toBe(false);

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

test("an accepted repair survives same-version rebuilds but not a new ordinal inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-repaired-retain-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const out = join(root, "yori.sqlite");
  const sourceSense = (text: string) => ({
    partOfSpeech: ["n"], appliesToKanji: ["*"], appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  const writeSource = async (version: string, glosses: string[]) => writeFile(input, JSON.stringify({
    version,
    dictDate: version,
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: glosses.map(sourceSense)
    }]
  }));
  await writeSource("fixture-v1", ["appearance", "manner"]);
  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1", lang: "zh-tw", glosses: ["舊的部分解釋"]
  }));
  await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  migrateProductionDatabase(out);

  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  const partial = repository.find("様", "ja", "zh-tw")!;
  repository.saveEntry({
    ...partial,
    senses: [{
      ...partial.senses[0]!,
      id: "yori:s_repaired_1410750:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "修復後的完整解釋", source: "generated", reviewStatus: "checked" }],
      evidenceIds: ["jmdict:1410750:1", "jmdict:1410750:2"],
      provenance: "source"
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  const identical = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  const identicalLookup = openLookupDb(out);
  const completeGroup = identicalLookup.lookup("様", "zh-tw").item;
  expect(completeGroup?.senses).toHaveLength(1);
  expect(completeGroup?.senses[0]?.glosses[0]?.text).toBe("修復後的完整解釋");
  expect(completeGroup?.senses[0]?.evidenceIds).toEqual([
    "jmdict:1410750:1",
    "jmdict:1410750:2"
  ]);
  identicalLookup.close();
  expect(identical.coverageGaps.summary["zh-tw"]).toBeUndefined();

  await writeSource("fixture-v2", ["appearance", "manner", "honorific title"]);
  const grown = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  const reopened = openLookupDb(out);
  expect(reopened.lookup("様", "zh-tw").item?.senses[0]?.glosses[0]?.text)
    .toBe("舊的部分解釋");
  reopened.close();
  expect(grown.coverageGaps.details.map((gap) => gap.missingEvidenceId)).toEqual([
    "jmdict:1410750:2",
    "jmdict:1410750:3"
  ]);

  await writeFile(glossPath, ["新的樣子", "新的方式", "新的敬稱"].map((gloss, index) => JSON.stringify({
    senseId: `yori:s_jmdict_1410750_${index + 1}`,
    lang: "zh-tw",
    glosses: [gloss]
  })).join("\n"));
  const completeImport = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  const completeLookup = openLookupDb(out);
  expect(completeLookup.lookup("様", "zh-tw").item?.senses.map((sense) => sense.glosses[0]?.text))
    .toEqual(["新的樣子", "新的方式", "新的敬稱"]);
  completeLookup.close();
  expect(completeImport.coverageGaps.summary["zh-tw"]).toBeUndefined();
});

test("retained ordinal Evidence does not cover a different sense in a newer source version", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-versioned-evidence-"));
  const input = join(root, "jmdict.json");
  const glossPath = join(root, "zh-tw.jsonl");
  const out = join(root, "yori.sqlite");
  const sourceSense = (text: string) => ({
    partOfSpeech: ["n"], appliesToKanji: ["*"], appliesToKana: ["*"],
    related: [], antonym: [], field: [], dialect: [], misc: [], info: [], languageSource: [],
    gloss: [{ lang: "eng", gender: null, type: null, text }]
  });
  const writeSource = async (version: string, glosses: string[]) => writeFile(input, JSON.stringify({
    version,
    dictDate: version,
    words: [{
      id: "1410750",
      kanji: [{ text: "様", common: true, tags: [] }],
      kana: [{ text: "さま", common: true, tags: [], appliesToKanji: ["*"] }],
      sense: glosses.map(sourceSense)
    }]
  }));

  await writeSource("fixture-v1", ["appearance", "manner"]);
  await writeFile(glossPath, JSON.stringify({
    senseId: "yori:s_jmdict_1410750_1", lang: "zh-tw", glosses: ["舊的部分解釋"]
  }));
  await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  migrateProductionDatabase(out);

  const lookup = openLookupDb(out);
  const repository = openEnrichmentRepository(out, lookup);
  const partial = repository.find("様", "ja", "zh-tw")!;
  repository.saveEntry({
    ...partial,
    senses: [{
      ...partial.senses[0]!,
      id: "yori:s_repaired_versioned_1410750:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "舊版本的完整解釋", source: "generated", reviewStatus: "checked" }],
      evidenceIds: ["jmdict:1410750:1", "jmdict:1410750:2"],
      provenance: "source"
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  // The new source inserts a different sense at position 1. Old ordinal IDs
  // must not claim that this new inventory has already been covered.
  await writeSource("fixture-v2", ["condition", "appearance", "manner"]);
  const rebuilt = await rebuildJapaneseDictionary({ input, aiGlosses: [glossPath], out });
  expect(rebuilt.coverageGaps.details.map((gap) => gap.missingEvidenceId)).toEqual([
    "jmdict:1410750:2",
    "jmdict:1410750:3"
  ]);
  const reopened = openLookupDb(out);
  expect(reopened.lookup("様", "zh-tw").item?.senses[0]?.glosses[0]?.text).toBe("舊的部分解釋");
  reopened.close();
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
