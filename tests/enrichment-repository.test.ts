import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { createEnglishSchema } from "../src/english-schema";
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
  // Each explanation language keeps its own sense list for the same entry.
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

test("a Japanese sense retains every Evidence relationship after reopening", async () => {
  const path = await productionDatabase();
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const entry = englishGroup(generatedEntry());
  entry.senses[0] = {
    ...entry.senses[0]!,
    provenance: "source",
    evidenceIds: ["jmdict:1410750:1", "jmdict:1410750:2"]
  };

  repository.saveEntry(entry, "en", generation);
  repository.close();
  lookup.close();

  const reopened = openLookupDb(path);
  expect(reopened.lookup(entry.word, "en").item?.senses[0]?.evidenceIds).toEqual([
    "jmdict:1410750:1",
    "jmdict:1410750:2"
  ]);
  reopened.close();
});

test("replacing one language clears only its gaps and rolls back all rows on storage failure", async () => {
  const path = await productionDatabase();
  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const original = taiwaneseGroup(generatedEntry());
  repository.saveEntry(original, "zh-tw", generation);
  const db = new Database(path);
  const addGap = db.prepare(`
    insert into ja_explanation_group_gaps
      (entry_id, lang, missing_evidence_id, source_version, basis)
    values (?, ?, ?, 'fixture', 'accepted-authored-evidence')
  `);
  addGap.run(original.id, "zh-tw", "jmdict:test:1");
  addGap.run(original.id, "en", "jmdict:test:2");
  db.close();

  const invalid = structuredClone(original);
  invalid.senses = [invalid.senses[0]!, { ...invalid.senses[0]!, position: 2 }];
  expect(() => repository.saveEntry(invalid, "zh-tw", generation)).toThrow();
  expect(repository.find(original.word, "ja", "zh-tw")?.senses[0]?.glosses[0]?.text).toBe("未知詞");

  const replacement = structuredClone(original);
  replacement.senses[0]!.glosses[0]!.text = "新的未知詞";
  repository.saveEntry(replacement, "zh-tw", generation);
  repository.close();
  lookup.close();

  const verified = new Database(path, { readonly: true });
  expect(verified.query<{ lang: string }, [string]>(`
    select lang from ja_explanation_group_gaps where entry_id = ? order by lang
  `).all(original.id)).toEqual([{ lang: "en" }]);
  verified.close();
});

test("production migrations are idempotent", async () => {
  const path = await productionDatabase();
  const legacy = new Database(path);
  legacy.exec("drop table ja_sense_evidence; drop table ja_explanation_group_gaps;");
  legacy.prepare("update ja_metadata set value = 'ja-2' where key = 'schemaVersion'").run();
  legacy.prepare(
    "delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)"
  ).run();
  legacy.close();
  migrateProductionDatabase(path);
  migrateProductionDatabase(path);
  const migrated = new Database(path, { readonly: true });
  expect(migrated.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'schemaVersion'"
  ).get()?.value).toBe("ja-2");
  expect(migrated.query<{ count: number }, []>(
    "select count(*) as count from ja_sense_evidence"
  ).get()?.count).toBe(0);
  migrated.close();
  const lookup = openLookupDb(path);
  expect(lookup.lookup("学校", "en").item?.word).toBe("学校");
  lookup.close();
});

test("a same-date ja-3 release upgrades a ja-2 Japanese store", async () => {
  const path = await productionDatabase();
  const releasePath = await productionDatabase();
  const production = new Database(path);
  production.prepare("update ja_metadata set value = 'ja-2' where key = 'schemaVersion'").run();
  production.close();

  expect(importJapaneseRelease(path, releasePath)).toBe(true);

  const upgraded = new Database(path, { readonly: true });
  expect(upgraded.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'schemaVersion'"
  ).get()?.value).toBe("ja-3");
  upgraded.close();
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

test("a production import keeps an accepted repair over proven-partial release content", async () => {
  const path = await productionDatabase();
  const entryId = "yori:e_jmdict_1206730";
  const sourceSenseId = "yori:s_jmdict_1206730_1:en";
  const firstEvidence = "jmdict:1206730:1";
  const secondEvidence = "jmdict:1206730:2";
  const thirdEvidence = "jmdict:1206730:3";
  const prepareExpectedEvidence = (db: Database, evidenceIds: string[]) => {
    const insert = db.prepare(`
      insert or ignore into ja_sense_evidence (sense_id, position, evidence_id, source_name)
      values (?, ?, ?, 'jmdict')
    `);
    evidenceIds.forEach((evidenceId, index) => insert.run(sourceSenseId, index + 2, evidenceId));
  };
  const production = new Database(path);
  createEnglishSchema(production);
  production.prepare("insert or replace into en_metadata (key, value) values ('dictionaryVersion', 'english-stable')")
    .run();
  prepareExpectedEvidence(production, [secondEvidence]);
  production.close();

  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  const english = repository.find("学校", "ja", "en")!;
  repository.saveEntry({
    ...english,
    senses: [{
      ...english.senses[0]!,
      id: "yori:s_repaired_school:zh-tw:1",
      glosses: [{ lang: "zh-tw", text: "修復後的學校解釋", source: "generated", reviewStatus: "checked" }],
      provenance: "source",
      evidenceIds: [firstEvidence, secondEvidence]
    }]
  }, "zh-tw", generation);
  repository.close();
  lookup.close();

  const next = join(mkdtempSync(join(tmpdir(), "yori-partial-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const release = new Database(next);
  prepareExpectedEvidence(release, [secondEvidence, thirdEvidence]);
  const source = release.query<Record<string, unknown>, [string]>(
    "select * from ja_senses where id = ?"
  ).get(sourceSenseId)!;
  const partialSenseId = "yori:s_jmdict_1206730_1:zh-tw";
  const partial: Record<string, unknown> = {
    ...source,
    id: partialSenseId,
    lang: "zh-tw",
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: "yori:s_jmdict_1206730_1",
    generation_id: "legacy:test"
  };
  release.prepare(`
    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values ('legacy:test', 'legacy', 'unrecorded', 'unrecorded', 'legacy', null, 'accepted', 'legacy')
  `).run();
  const columns = Object.keys(partial);
  release.prepare(`insert into ja_senses (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => partial[column] as never));
  release.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, '舊的部分解釋', 'generated', 'checked')"
  ).run(partialSenseId);
  release.prepare(
    "insert into ja_sense_evidence (sense_id, position, evidence_id, source_name) values (?, 1, ?, 'yori-legacy')"
  ).run(partialSenseId, firstEvidence);
  release.prepare(`
    insert into ja_explanation_group_gaps
      (entry_id, lang, missing_evidence_id, source_version, basis)
    values (?, 'zh-tw', ?, ?, 'legacy-exact-sense-mapping')
  `).run(entryId, secondEvidence, String(source.source_version));
  release.prepare(`
    insert into ja_explanation_group_gaps
      (entry_id, lang, missing_evidence_id, source_version, basis)
    values (?, 'zh-tw', ?, ?, 'legacy-exact-sense-mapping')
  `).run(entryId, thirdEvidence, String(source.source_version));
  release.prepare("update ja_metadata set value = 'next' where key = 'dictDate'").run();
  release.close();

  expect(importJapaneseRelease(path, next)).toBe(true);

  const refreshed = openLookupDb(path);
  expect(refreshed.lookup("学校", "zh-tw").item?.senses[0]?.glosses[0]?.text)
    .toBe("修復後的學校解釋");
  expect(refreshed.lookup("学校", "zh-tw").item?.senses[0]?.evidenceIds)
    .toEqual([firstEvidence, secondEvidence]);
  refreshed.close();
  const verified = new Database(path, { readonly: true });
  expect(verified.query<{ missing_evidence_id: string }, []>(`
    select missing_evidence_id from ja_explanation_group_gaps
     where entry_id = 'yori:e_jmdict_1206730' and lang = 'zh-tw'
     order by missing_evidence_id
  `).all()).toEqual([{ missing_evidence_id: thirdEvidence }]);
  verified.close();

  // The ordinal identifiers belong to the source inventory that assigned
  // them. Once that inventory changes, the old accepted repair cannot claim
  // coverage of the release's newly numbered senses.
  const versionedRelease = new Database(next);
  versionedRelease.prepare("update ja_senses set source_version = 'fixture-v2'").run();
  versionedRelease.prepare(`
    update ja_explanation_group_gaps
       set source_version = 'fixture-v2'
     where entry_id = ? and lang = 'zh-tw'
  `).run(entryId);
  versionedRelease.prepare("update ja_glosses set text = '新版部分解釋' where sense_id = ?")
    .run(partialSenseId);
  versionedRelease.prepare("update ja_metadata set value = 'next-v2' where key = 'dictDate'").run();
  versionedRelease.prepare(
    "update ja_metadata set value = 'fixture-v2' where key = 'jmdictSimplifiedVersion'"
  ).run();
  versionedRelease.close();

  expect(importJapaneseRelease(path, next)).toBe(true);
  const versioned = openLookupDb(path);
  expect(versioned.lookup("学校", "zh-tw").item?.senses[0]?.glosses[0]?.text)
    .toBe("新版部分解釋");
  versioned.close();

  const completeRelease = new Database(next);
  completeRelease.prepare("delete from ja_explanation_group_gaps where entry_id = ? and lang = 'zh-tw'")
    .run(entryId);
  completeRelease.prepare("update ja_glosses set text = '完整發布解釋一' where sense_id = ?")
    .run(partialSenseId);
  for (const [position, evidenceId, gloss] of [
    [2, secondEvidence, "完整發布解釋二"],
    [3, thirdEvidence, "完整發布解釋三"]
  ] as const) {
    const senseId = `yori:s_jmdict_1206730_${position}:zh-tw`;
    const row: Record<string, unknown> = { ...partial, id: senseId, position, source_ref: evidenceId };
    const rowColumns = Object.keys(row);
    completeRelease.prepare(
      `insert into ja_senses (${rowColumns.join(", ")}) values (${rowColumns.map(() => "?").join(", ")})`
    ).run(...rowColumns.map((column) => row[column] as never));
    completeRelease.prepare(
      "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, ?, 'generated', 'checked')"
    ).run(senseId, gloss);
    completeRelease.prepare(
      "insert into ja_sense_evidence (sense_id, position, evidence_id, source_name) values (?, 1, ?, 'yori-legacy')"
    ).run(senseId, evidenceId);
  }
  completeRelease.prepare("update ja_metadata set value = 'complete' where key = 'dictDate'").run();
  completeRelease.close();

  expect(importJapaneseRelease(path, next)).toBe(true);
  const authoritative = openLookupDb(path);
  expect(authoritative.lookup("学校", "zh-tw").item?.senses.map((sense) => sense.glosses[0]?.text))
    .toEqual(["完整發布解釋一", "完整發布解釋二", "完整發布解釋三"]);
  authoritative.close();
  const englishDb = new Database(path, { readonly: true });
  expect(englishDb.query<{ value: string }, []>(
    "select value from en_metadata where key = 'dictionaryVersion'"
  ).get()?.value).toBe("english-stable");
  englishDb.close();
});

test("a production import recovers retained legacy source_ref Evidence before replacement", async () => {
  const path = await productionDatabase();
  const entryId = "yori:e_jmdict_1206730";
  const sourceSenseId = "yori:s_jmdict_1206730_1:en";
  const targetSenseId = "yori:s_migrated_school:zh-tw:1";
  const firstEvidence = "jmdict:1206730:1";
  const secondEvidence = "jmdict:1206730:2";
  const production = new Database(path);
  production.prepare(`
    insert into ja_sense_evidence (sense_id, position, evidence_id, source_name)
    values (?, 2, ?, 'jmdict')
  `).run(sourceSenseId, secondEvidence);
  const source = production.query<Record<string, unknown>, [string]>(
    "select * from ja_senses where id = ?"
  ).get(sourceSenseId)!;
  production.prepare(`
    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values ('legacy:migrated', 'legacy', 'unrecorded', 'unrecorded', 'legacy', null, 'accepted', 'legacy')
  `).run();
  const retained: Record<string, unknown> = {
    ...source,
    id: targetSenseId,
    lang: "zh-tw",
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: "yori:s_jmdict_1206730_1",
    generation_id: "legacy:migrated"
  };
  const retainedColumns = Object.keys(retained);
  production.prepare(
    `insert into ja_senses (${retainedColumns.join(", ")}) values (${retainedColumns.map(() => "?").join(", ")})`
  ).run(...retainedColumns.map((column) => retained[column] as never));
  production.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, '保留的舊解釋', 'generated', 'checked')"
  ).run(targetSenseId);
  production.prepare("update ja_metadata set value = 'ja-2' where key = 'schemaVersion'").run();
  production.close();

  const next = join(mkdtempSync(join(tmpdir(), "yori-migrated-partial-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const release = new Database(next);
  release.prepare(`
    insert into ja_sense_evidence (sense_id, position, evidence_id, source_name)
    values (?, 2, ?, 'jmdict')
  `).run(sourceSenseId, secondEvidence);
  const incomingSenseId = "yori:s_jmdict_1206730_1:zh-tw";
  const incoming: Record<string, unknown> = {
    ...source,
    id: incomingSenseId,
    lang: "zh-tw",
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: "yori:s_jmdict_1206730_1",
    generation_id: "legacy:release"
  };
  release.prepare(`
    insert into ja_generations
      (id, model, provider, reasoning_effort, prompt_version, service_tier, review_outcome, created_at)
    values ('legacy:release', 'legacy', 'unrecorded', 'unrecorded', 'legacy', null, 'accepted', 'legacy')
  `).run();
  const incomingColumns = Object.keys(incoming);
  release.prepare(
    `insert into ja_senses (${incomingColumns.join(", ")}) values (${incomingColumns.map(() => "?").join(", ")})`
  ).run(...incomingColumns.map((column) => incoming[column] as never));
  release.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, '發布的部分解釋', 'generated', 'checked')"
  ).run(incomingSenseId);
  release.prepare(`
    insert into ja_sense_evidence (sense_id, position, evidence_id, source_name)
    values (?, 1, ?, 'yori-legacy')
  `).run(incomingSenseId, firstEvidence);
  release.prepare(`
    insert into ja_explanation_group_gaps
      (entry_id, lang, missing_evidence_id, source_version, basis)
    values (?, 'zh-tw', ?, ?, 'legacy-exact-sense-mapping')
  `).run(entryId, secondEvidence, String(source.source_version));
  release.prepare("update ja_metadata set value = 'next' where key = 'dictDate'").run();
  release.close();

  expect(importJapaneseRelease(path, next)).toBe(true);
  const imported = openLookupDb(path);
  expect(imported.lookup("学校", "zh-tw").item?.senses[0]?.glosses[0]?.text).toBe("保留的舊解釋");
  expect(imported.lookup("学校", "zh-tw").item?.senses[0]?.evidenceIds).toEqual([firstEvidence]);
  imported.close();
  const verified = new Database(path, { readonly: true });
  expect(verified.query<{ missing_evidence_id: string }, [string]>(`
    select missing_evidence_id from ja_explanation_group_gaps
     where entry_id = ? and lang = 'zh-tw'
  `).all(entryId)).toEqual([{ missing_evidence_id: secondEvidence }]);
  verified.close();

  // A retained group with neither normalized Evidence nor a legacy reference
  // cannot prove coverage, so it must not displace the release's mapped group.
  const evidenceFree = new Database(path);
  evidenceFree.prepare("delete from ja_sense_evidence where sense_id = ?").run(targetSenseId);
  evidenceFree.prepare("update ja_senses set source_ref = null where id = ?").run(targetSenseId);
  evidenceFree.close();
  const secondRelease = new Database(next);
  secondRelease.prepare("update ja_metadata set value = 'next-2' where key = 'dictDate'").run();
  secondRelease.prepare("update ja_glosses set text = '發布的可追溯解釋' where sense_id = ?")
    .run(incomingSenseId);
  secondRelease.close();

  expect(importJapaneseRelease(path, next)).toBe(true);
  const authoritative = openLookupDb(path);
  expect(authoritative.lookup("学校", "zh-tw").item?.senses[0]?.glosses[0]?.text)
    .toBe("發布的可追溯解釋");
  expect(authoritative.lookup("学校", "zh-tw").item?.senses[0]?.evidenceIds)
    .toEqual([firstEvidence]);
  authoritative.close();
});

test("a failed Japanese production import rolls back the existing dictionary", async () => {
  const path = await productionDatabase();
  const before = new Database(path, { readonly: true });
  const previousVersion = before.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'dictDate'"
  ).get()?.value;
  before.close();
  const next = join(mkdtempSync(join(tmpdir(), "yori-broken-release-")), "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${next}`.quiet();
  const broken = new Database(next);
  broken.prepare("update ja_metadata set value = 'broken-next' where key = 'dictDate'").run();
  broken.exec("drop table ja_glosses");
  broken.close();

  expect(() => importJapaneseRelease(path, next)).toThrow();

  const lookup = openLookupDb(path);
  expect(lookup.lookup("学校", "en").item?.word).toBe("学校");
  lookup.close();
  const after = new Database(path, { readonly: true });
  expect(after.query<{ value: string }, []>(
    "select value from ja_metadata where key = 'dictDate'"
  ).get()?.value).toBe(previousVersion);
  after.close();
});

test("a generated example is appended after the imported examples of its sense", async () => {
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
  // would keep answering lookups with its own stale senses.
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

/** One entry-language group: only this language's senses and glosses. */
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
