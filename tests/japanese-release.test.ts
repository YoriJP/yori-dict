import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLookupDb } from "../src/db";
import { openEnrichmentRepository } from "../src/enrichment-repository";
import { buildJapaneseRelease, type JapaneseReleaseArtifacts } from "../src/japanese-release";
import { migrateProductionDatabase } from "../src/production-database";
import type { ApiLang, PublicLookupItem } from "../src/types";
import { openZipFile } from "../src/stored-zip";

const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const han = /\p{Script=Han}/u;
const hangul = /\p{Script=Hangul}/u;

/**
 * Text that could not have been written in `lang`. This is deliberately about
 * writing system rather than wording: it catches the real failure mode, one
 * language's glosses being published under another language's name.
 */
function foreignToLanguage(lang: string, text: string): boolean {
  if (lang === "en" || lang === "de") return kana.test(text) || han.test(text) || hangul.test(text);
  if (lang === "zh-tw" || lang === "zh-cn") return kana.test(text) || hangul.test(text);
  if (lang === "ko") return kana.test(text) || !hangul.test(text);
  return false;
}

test("the Japanese release publishes sibling language groups, per-language packs, and coverage", async () => {
  const { artifacts } = await release();

  const rows = (await Bun.file(artifacts.jsonl).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(15);

  const generated = rows.find((entry) => entry.word === "未知語");
  expect(Object.keys(generated.languages).sort()).toEqual(["en", "zh-tw"]);
  // One entry, different sense counts, identifiers, wording, and order per
  // explanation language.
  expect(generated.languages.en.senses.map((sense: { glosses: Array<{ text: string }> }) =>
    sense.glosses.map(({ text }) => text)
  )).toEqual([["unknown term"], ["unlisted word"]]);
  expect(generated.languages["zh-tw"].senses.map((sense: { glosses: Array<{ text: string }> }) =>
    sense.glosses.map(({ text }) => text)
  )).toEqual([["未知詞"]]);
  expect(generated.languages.en.senses[0].id).not.toBe(generated.languages["zh-tw"].senses[0].id);
  expect(generated.languages.en.senses[0].provenance).toBe("generated");

  // Imported senses keep JMdict order inside each language and carry concise
  // source identifiers rather than raw source payloads.
  const eat = rows.find((entry) => entry.word === "食べる");
  expect(eat.languages.en.senses[0].sources).toEqual(["jmdict:1358280:1"]);
  expect(JSON.stringify(rows)).not.toContain("rawRecord");

  const manifest = JSON.parse(await Bun.file(artifacts.manifest).text());
  expect(manifest.entries).toBe(15);
  expect(manifest.coverage.en).toEqual({ entries: 15, senses: 18, glosses: 21, examples: 2 });
  expect(manifest.coverage["zh-tw"]).toEqual({ entries: 2, senses: 2, glosses: 2, examples: 0 });
  expect(manifest.yomitan).toEqual({
    en: "yori-ja-en.zip",
    "zh-tw": "yori-ja-zh-tw.zip"
  });
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.sources.map((source: { license: string }) => source.license)).toContain("CC-BY-SA-4.0");
  // An attribution record a redistributor cannot follow is not actionable.
  for (const source of manifest.sources as Array<{ license: string; url: string }>) {
    expect(source.license).not.toBe("");
    expect(source.url).toMatch(/^https:\/\//);
  }
  expect(manifest.jmdictSimplifiedVersion).toBeTruthy();

  const released = new Database(artifacts.sqlite, { readonly: true });
  expect(released.query<{ name: string }, []>(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'ja_%'"
  ).all()).toEqual([]);
  released.close();
});

test("no release artifact mixes explanation languages", async () => {
  const { artifacts } = await release();
  const released = new Database(artifacts.sqlite, { readonly: true });

  // Every gloss and example in the released SQLite belongs to exactly one
  // sense, and that sense declares exactly one explanation language.
  expect(released.query<{ count: number }, []>(`
    select count(*) as count from ja_glosses gloss
     where (select count(*) from ja_senses sense where sense.id = gloss.sense_id) <> 1
  `).get()?.count).toBe(0);
  expect(released.query<{ count: number }, []>(`
    select count(*) as count from ja_examples example
     where (select count(*) from ja_senses sense where sense.id = example.sense_id) <> 1
  `).get()?.count).toBe(0);

  const glosses = released.query<{ lang: string; text: string }, []>(
    "select sense.lang as lang, gloss.text as text from ja_glosses gloss join ja_senses sense on sense.id = gloss.sense_id"
  ).all();
  expect(glosses.filter(({ lang, text }) => foreignToLanguage(lang, text))).toEqual([]);

  const examples = released.query<{ lang: string; translations: string }, []>(
    "select sense.lang as lang, example.translations as translations from ja_examples example join ja_senses sense on sense.id = example.sense_id"
  ).all();
  for (const example of examples) {
    // A bilingual pair stays with the language that owns it.
    expect(JSON.parse(example.translations).map((item: { lang: string }) => item.lang)).toEqual([example.lang]);
  }
  released.close();

  for (const row of (await Bun.file(artifacts.jsonl).text()).trim().split("\n")) {
    const entry = JSON.parse(row) as {
      languages: Record<string, { senses: Array<{ lang: string; glosses: Array<{ text: string }>; examples: Array<{ translations: Array<{ lang: string }> }> }> }>;
    };
    for (const [lang, group] of Object.entries(entry.languages)) {
      for (const sense of group.senses) {
        expect(sense.lang).toBe(lang);
        for (const gloss of sense.glosses) expect(foreignToLanguage(lang, gloss.text)).toBe(false);
        for (const example of sense.examples) {
          expect(example.translations.map(({ lang: pairLang }) => pairLang)).toEqual([lang]);
        }
      }
    }
  }

  // Each pack holds only the glosses of the language it is named for, and the
  // packs of two languages never share a term list.
  const packs = new Map<string, string[]>();
  for (const [lang, path] of Object.entries(artifacts.yomitan)) {
    const index = JSON.parse(await packEntry(path, "index.json"));
    expect(index.description).toContain(lang);
    const terms = JSON.parse(await packEntry(path, "term_bank_1.json")) as unknown[][];
    const definitions = terms.flatMap((term) => term[5] as string[]);
    expect(definitions.filter((text) => foreignToLanguage(lang, text))).toEqual([]);
    packs.set(lang, definitions);
  }
  expect(new Set(packs.get("en"))).not.toEqual(new Set(packs.get("zh-tw")));
  // 食べる carries a variant written form, and each form gets its own row so a
  // reader scanning the variant finds the entry too.
  expect(packs.get("zh-tw")).toEqual(["未知詞", "吃", "吃"]);
});

test("a pack row carries the inflection class Yomitan validates deinflections against", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  const rules = (word: string) => terms.find((term) => term[0] === word)?.[3];

  // An ichidan verb, so a reader scanning 食べた reaches this entry instead of
  // having the conditions check reject every inflected candidate.
  expect(rules("食べる")).toBe("v1");
  // Every godan class collapses to the one condition Yomitan branches on.
  expect(rules("読む")).toBe("v5");
  expect(rules("行く")).toBe("v5");
  expect(rules("高い")).toBe("adj-i");
  // A noun does not inflect, and the empty value is what the schema means by
  // "no grammatical category" rather than a wildcard.
  expect(rules("学校")).toBe("");
});

test("a pack row ranks common written forms above the rest", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  const scores = new Map(terms.map((term) => [term[0] as string, term[4] as number]));

  // 食べる is a common JMdict headword and 遇う is not. Without a score both
  // are ranked by locale collation.
  expect(scores.get("食べる")!).toBeGreaterThan(scores.get("遇う")!);
  expect(scores.get("食べる")).toBeGreaterThan(0);
  // Inside one entry the preferred written form outranks its variants, and no
  // variant can climb past a common form of another entry.
  expect(scores.get("遇う")!).toBeGreaterThan(scores.get("配う")!);
  expect(scores.get("配う")!).toBeLessThan(scores.get("食べる")!);
  for (const score of scores.values()) expect(Number.isInteger(score)).toBe(true);
});

test("a pack row carries only the senses its own written form is given", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  const glossary = (word: string) => terms.find((term) => term[0] === word)?.[5] as string[];

  // JMdict restricts the "to treat" sense to the kanji form 遇う. A row built
  // from the whole group would publish that sense under 配う too, and hand
  // that form the sense's inflection behaviour with it.
  expect(glossary("遇う")).toEqual(["to treat", "to handle", "to arrange"]);
  expect(glossary("配う")).toEqual(["to arrange"]);
  // The restriction names kanji, so it does not constrain the kana form: the
  // sense's own `appliesToKana` is `*` and あしらう keeps it.
  expect(glossary("あしらう")).toEqual(["to treat", "to handle", "to arrange"]);
});

test("one entry's written forms share one sequence rather than becoming separate entries", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  const sequence = (word: string) => terms.find((term) => term[0] === word)?.[6];

  // The pack is `sequenced`, so a shared sequence is what tells Yomitan these
  // are one entry's spellings rather than three unrelated entries.
  expect(sequence("遇う")).toBe(sequence("配う"));
  expect(sequence("遇う")).toBe(sequence("あしらう"));
  expect(sequence("遇う")).not.toBe(sequence("食べる"));
});

test("a pack credits EDRDG where a Yomitan user will actually read it", async () => {
  const { artifacts } = await release();
  for (const path of Object.values(artifacts.yomitan)) {
    const index = JSON.parse(await packEntry(path, "index.json"));
    // The licence requires the acknowledgement reach a user, and the details
    // pane is the one place Yomitan renders this field.
    expect(index.attribution).toContain("Electronic Dictionary Research and Development Group");
    expect(index.attribution).toContain("JMdict/EDICT");
    expect(index.attribution).toContain("https://www.edrdg.org/");
  }
});

test("imported gloss language survives release into its own pack", async () => {
  const { artifacts } = await release();
  // 学校 is a fixture entry with imported glosses on the same JMdict sense in
  // more than one source language.
  const englishTerms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  expect(englishTerms.find((term) => term[0] === "学校")?.[5]).toEqual(["school"]);

  const taiwaneseTerms = JSON.parse(await packEntry(artifacts.yomitan["zh-tw"], "term_bank_1.json")) as unknown[][];
  expect(taiwaneseTerms.find((term) => term[0] === "食べる")?.[5]).toEqual(["吃"]);
});

test("a JMdict component EDRDG does not license never reaches a release", async () => {
  const { artifacts } = await release();
  // The fixture carries German glosses on 学校 and 食べる. EDRDG's licence
  // covers only the Japanese and English components, so those glosses are
  // dropped at import and no artifact mentions them.
  expect(artifacts.yomitan.de).toBeUndefined();

  const manifest = JSON.parse(await Bun.file(artifacts.manifest).text());
  expect(manifest.coverage.de).toBeUndefined();
  expect(Object.keys(manifest.yomitan)).not.toContain("de");

  const jsonl = await Bun.file(artifacts.jsonl).text();
  expect(jsonl).not.toContain("Schule");
  expect(jsonl).not.toContain('"de"');

  const released = new Database(artifacts.sqlite, { readonly: true });
  expect(released.query<{ lang: string }, []>("select distinct lang from ja_senses order by lang").all())
    .toEqual([{ lang: "en" }, { lang: "zh-tw" }]);
  released.close();
});

test("a Yomitan pack keeps its language's sense order and coexists with the others", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await packEntry(artifacts.yomitan.en, "term_bank_1.json")) as unknown[][];
  const generated = terms.find((term) => term[0] === "未知語");
  expect(generated?.[5]).toEqual(["unknown term", "unlisted word"]);

  const names = Object.values(artifacts.yomitan).map((path) => path.split("/").at(-1));
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain("yori-ja-en.zip");
});

test("repeating a release from identical accepted data is deterministic", async () => {
  const { path } = await release();
  const first = await buildJapaneseRelease(path, { outputDirectory: mkdtempSync(join(tmpdir(), "yori-ja-r1-")), version: "test" });
  const second = await buildJapaneseRelease(path, { outputDirectory: mkdtempSync(join(tmpdir(), "yori-ja-r2-")), version: "test" });

  expect(await Bun.file(second.jsonl).text()).toEqual(await Bun.file(first.jsonl).text());
  expect(await Bun.file(second.manifest).text()).toEqual(await Bun.file(first.manifest).text());
  for (const lang of Object.keys(first.yomitan)) {
    expect(await Bun.file(second.yomitan[lang]).bytes()).toEqual(await Bun.file(first.yomitan[lang]).bytes());
  }
});

async function release(): Promise<{ path: string; artifacts: JapaneseReleaseArtifacts }> {
  const root = mkdtempSync(join(tmpdir(), "yori-ja-release-"));
  const path = join(root, "production.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --examples fixtures/jmdict-examples-sample.json --out ${path}`.quiet();
  migrateProductionDatabase(path);

  const lookup = openLookupDb(path);
  const repository = openEnrichmentRepository(path, lookup);
  repository.saveEntry(generatedGroup("en", ["unknown term", "unlisted word"]), "en", generation);
  repository.saveEntry(generatedGroup("zh-tw", ["未知詞"]), "zh-tw", generation);
  repository.close();
  lookup.close();

  addLegacyTaiwaneseMeaning(path, "yori:s_jmdict_1358280_1", "吃");

  return {
    path,
    artifacts: await buildJapaneseRelease(path, { outputDirectory: join(root, "release"), version: "test" })
  };
}

const generation = {
  model: "gpt-5.6-luna",
  provider: "openrouter",
  reasoningEffort: "minimal",
  promptVersion: "entry-author-v1",
  serviceTier: "flex",
  reviewOutcome: "accepted",
  createdAt: "2026-08-08T00:00:00.000Z"
};

/** One authored entry-language group with its own senses, ids, and order. */
function generatedGroup(lang: ApiLang, glosses: string[]): PublicLookupItem {
  return {
    id: "yori:e_generated_release_test",
    word: "未知語",
    reading: "みちご",
    common: false,
    source: "generated",
    sourceId: "yori:e_generated_release_test",
    headwordLanguage: "ja",
    headwords: [{ text: "未知語", reading: "みちご", kind: "kanji", common: false, tags: [] }],
    senses: glosses.map((text, index) => ({
      id: `yori:s_generated_release_test:${lang}:${index + 1}`,
      position: index + 1,
      appliesTo: { kanji: ["*"], kana: ["*"] },
      partOfSpeech: ["n"],
      glosses: [{ lang, text, source: "generated" as const, reviewStatus: "checked" as const }],
      provenance: "generated" as const,
      evidenceIds: []
    }))
  };
}

/**
 * Legacy accepted Taiwanese content enters through an exact imported sense
 * identifier and becomes that language's own sense.
 */
function addLegacyTaiwaneseMeaning(path: string, baseSenseId: string, gloss: string): void {
  const db = new Database(path);
  const source = db.query<Record<string, unknown>, [string]>("select * from ja_senses where id = ?")
    .get(`${baseSenseId}:en`)!;
  const row: Record<string, unknown> = {
    ...source,
    id: `${baseSenseId}:zh-tw`,
    lang: "zh-tw",
    position: 1,
    provenance: "generated",
    source_name: "yori-legacy",
    source_ref: baseSenseId
  };
  const columns = Object.keys(row);
  db.prepare(`insert into ja_senses (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column] as never));
  db.prepare(
    "insert into ja_glosses (sense_id, position, text, source, review_status) values (?, 1, ?, 'generated', 'checked')"
  ).run(`${baseSenseId}:zh-tw`, gloss);
  db.close();
}

/** Reads one file out of a produced Yomitan pack. */
async function packEntry(path: string, name: string): Promise<string> {
  return (await openZipFile(path)).text(name);
}
