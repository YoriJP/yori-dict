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
  // One entry, different meaning counts, identifiers, wording, and order per
  // explanation language.
  expect(generated.languages.en.meanings.map((meaning: { glosses: Array<{ text: string }> }) =>
    meaning.glosses.map(({ text }) => text)
  )).toEqual([["unknown term"], ["unlisted word"]]);
  expect(generated.languages["zh-tw"].meanings.map((meaning: { glosses: Array<{ text: string }> }) =>
    meaning.glosses.map(({ text }) => text)
  )).toEqual([["未知詞"]]);
  expect(generated.languages.en.meanings[0].id).not.toBe(generated.languages["zh-tw"].meanings[0].id);
  expect(generated.languages.en.meanings[0].provenance).toBe("generated");

  // Imported meanings keep JMdict order inside each language and carry concise
  // source identifiers rather than raw source payloads.
  const eat = rows.find((entry) => entry.word === "食べる");
  expect(eat.languages.en.meanings[0].sources).toEqual(["jmdict:1358280:1"]);
  expect(JSON.stringify(rows)).not.toContain("rawRecord");

  const manifest = JSON.parse(await Bun.file(artifacts.manifest).text());
  expect(manifest.entries).toBe(15);
  expect(manifest.coverage.en).toEqual({ entries: 15, meanings: 18, glosses: 21, examples: 2 });
  expect(manifest.coverage.de).toEqual({ entries: 2, meanings: 2, glosses: 2, examples: 0 });
  expect(manifest.coverage["zh-tw"]).toEqual({ entries: 2, meanings: 2, glosses: 2, examples: 0 });
  expect(manifest.yomitan).toEqual({
    en: "yori-ja-en.zip",
    de: "yori-ja-de.zip",
    "zh-tw": "yori-ja-zh-tw.zip"
  });
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.sources.map((source: { license: string }) => source.license)).toContain("CC-BY-SA-4.0");
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
  // meaning, and that meaning declares exactly one explanation language.
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
      languages: Record<string, { meanings: Array<{ lang: string; glosses: Array<{ text: string }>; examples: Array<{ translations: Array<{ lang: string }> }> }> }>;
    };
    for (const [lang, group] of Object.entries(entry.languages)) {
      for (const meaning of group.meanings) {
        expect(meaning.lang).toBe(lang);
        for (const gloss of meaning.glosses) expect(foreignToLanguage(lang, gloss.text)).toBe(false);
        for (const example of meaning.examples) {
          expect(example.translations.map(({ lang: pairLang }) => pairLang)).toEqual([lang]);
        }
      }
    }
  }

  // Each pack holds only the glosses of the language it is named for, and the
  // packs of two languages never share a term list.
  const packs = new Map<string, string[]>();
  for (const [lang, path] of Object.entries(artifacts.yomitan)) {
    const index = JSON.parse(await Bun.$`unzip -p ${path} index.json`.text());
    expect(index.description).toContain(lang);
    const terms = JSON.parse(await Bun.$`unzip -p ${path} term_bank_1.json`.text()) as unknown[][];
    const definitions = terms.flatMap((term) => term[5] as string[]);
    expect(definitions.filter((text) => foreignToLanguage(lang, text))).toEqual([]);
    packs.set(lang, definitions);
  }
  expect(new Set(packs.get("en"))).not.toEqual(new Set(packs.get("zh-tw")));
  expect(packs.get("zh-tw")).toEqual(["未知詞", "吃"]);
});

test("imported gloss language survives release into its own pack", async () => {
  const { artifacts } = await release();
  // 学校 is a fixture entry with both English and German imported glosses on
  // the same JMdict meaning.
  const germanTerms = JSON.parse(
    await Bun.$`unzip -p ${artifacts.yomitan.de} term_bank_1.json`.text()
  ) as unknown[][];
  expect(germanTerms.map((term) => [term[0], term[5]])).toEqual([
    ["学校", ["Schule"]],
    ["食べる", ["essen"]]
  ]);

  const englishTerms = JSON.parse(
    await Bun.$`unzip -p ${artifacts.yomitan.en} term_bank_1.json`.text()
  ) as unknown[][];
  const english = englishTerms.find((term) => term[0] === "学校");
  expect(english?.[5]).toEqual(["school"]);
});

test("a Yomitan pack keeps its language's meaning order and coexists with the others", async () => {
  const { artifacts } = await release();
  const terms = JSON.parse(await Bun.$`unzip -p ${artifacts.yomitan.en} term_bank_1.json`.text()) as unknown[][];
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

/** One authored entry-language group with its own meanings, ids, and order. */
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
 * Legacy accepted Taiwanese content enters through an exact imported meaning
 * identifier and becomes that language's own meaning.
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
