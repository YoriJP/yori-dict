import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { LookupDb } from "../src/db";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import { chooseEnglishLevels, parseEnglishLevelList, type EnglishLevelSourceInput } from "../src/english-levels";
import { rebuildEnglishDictionary, type EnglishSourceInput } from "../src/english-rebuild";
import { importEnglishRelease, migrateProductionDatabase } from "../src/production-database";
import { createStoredZip } from "../src/stored-zip";

const cefrj = "headword,pos,CEFR,CoreInventory 1,CoreInventory 2,Threshold\r\n" +
  "run,noun,A2,,,\r\nrun,verb,A1,,,\r\nrich,adjective,A1,,,\r\ncolor/colour,noun,A1,\"Colours, shapes\",,\r\n";
const octanove = "headword,pos,CEFR,notes\r\n" +
  "rich,adjective,C1,containing a lot of fat/flavor\r\ntimid,adjective,C1,\r\nturn to ,verb,C1,\r\n";

test("a level list rates every spelling variant of a headword", () => {
  expect(parseEnglishLevelList(cefrj)).toEqual([
    { term: "run", level: "A2" },
    { term: "run", level: "A1" },
    { term: "rich", level: "A1" },
    { term: "color", level: "A1" },
    { term: "colour", level: "A1" }
  ]);
  expect(parseEnglishLevelList(octanove).at(-1)).toEqual({ term: "turn to", level: "C1" });
  expect(() => parseEnglishLevelList("headword,pos,CEFR\nrun,verb,X1\n")).toThrow("Unknown CEFR band");
  expect(() => parseEnglishLevelList("word,level\nrun,A1\n")).toThrow("Expected a headword,pos,CEFR level list");
});

test("a headword rated several times keeps its easiest band, whichever list rates it", () => {
  const lists = [
    { sourceName: "cefr-j", sourceVersion: "1.5", text: cefrj },
    { sourceName: "octanove", sourceVersion: "1.0", text: octanove }
  ];
  for (const ordered of [lists, [...lists].reverse()]) {
    const levels = chooseEnglishLevels(ordered);
    expect(levels.get("run")).toEqual({ level: "A1", sourceName: "cefr-j", sourceVersion: "1.5" });
    // Octanove rates one rare sense of `rich`; the word itself is A1.
    expect(levels.get("rich")).toEqual({ level: "A1", sourceName: "cefr-j", sourceVersion: "1.5" });
    expect(levels.get("timid")).toEqual({ level: "C1", sourceName: "octanove", sourceVersion: "1.0" });
    expect(levels.has("ubiquitous")).toBe(false);
  }
});

test("a rebuild rates entries by exact headword and leaves unrated entries without a level", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-levels-"));
  const out = join(root, "english.sqlite");
  const result = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    levelSources: await levelSources(root),
    out,
    version: "test",
    retainFrom: null
  });
  expect(result.levels).toEqual({ A1: 2, A2: 0, B1: 0, B2: 0, C1: 1, C2: 0 });

  const db = new Database(out, { readonly: true });
  expect(db.query<{ lookup_term: string; level: string; source_name: string }, []>(`
    select entry.lookup_term, level.level, level.source_name
      from en_entries entry left join en_entry_levels level on level.entry_id = entry.id
     order by entry.lookup_term
  `).all()).toEqual([
    { lookup_term: "colour", level: "A1", source_name: "cefr-j" },
    { lookup_term: "run", level: "A1", source_name: "cefr-j" },
    { lookup_term: "timid", level: "C1", source_name: "octanove" },
    { lookup_term: "ubiquitous", level: null as never, source_name: null as never }
  ]);
  const sources = JSON.parse(db.query<{ value: string }, []>(
    "select value from en_metadata where key = 'sources'"
  ).get()!.value) as Array<{ source: string; role: string; lang?: string }>;
  expect(sources.filter(({ role }) => role === "estimated-level").map(({ source, lang }) => ({ source, lang })))
    .toEqual([{ source: "cefr-j", lang: undefined }, { source: "octanove", lang: undefined }]);
  db.close();
});

test("an English lookup carries the Estimated Level the production graft installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-levels-lookup-"));
  const production = join(root, "yori.sqlite");
  migrateProductionDatabase(production);
  const release = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    levelSources: await levelSources(root),
    out: join(root, "english.sqlite"),
    version: "test",
    retainFrom: null
  });
  expect(importEnglishRelease(production, release.path)).toBe(true);

  const repository = openEnglishEnrichmentRepository(production);
  try {
    const app = createApp({} as LookupDb, { englishLookupAll: (query, lang) => repository.findAll(query, lang) });
    const lookup = async (query: string) =>
      (await app.request(`/v1/lookup?q=${encodeURIComponent(query)}&dictionary=en&lang=en`)).json();

    expect(await lookup("run")).toMatchObject({ headword: "run", estimatedLevel: "A1" });
    // An inflected surface answers with its lemma's entry, and so its level.
    expect(await lookup("runs")).toMatchObject({ headword: "run", estimatedLevel: "A1" });
    expect(await lookup("ubiquitous")).not.toHaveProperty("estimatedLevel");

    const batch = await (await app.request("/v1/lookup/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dictionary: "en", lang: "en", queries: ["timid", "ubiquitous", "colour"] })
    })).json() as { entries: Array<{ estimatedLevel?: string } | null> };
    expect(batch.entries.map((entry) => entry?.estimatedLevel ?? null)).toEqual(["C1", null, "A1"]);
  } finally {
    repository.close();
  }
});

test("grafting a release exported before levels existed leaves its entries unrated", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-levels-legacy-"));
  const production = join(root, "yori.sqlite");
  migrateProductionDatabase(production);
  const rated = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    levelSources: await levelSources(root),
    out: join(root, "rated.sqlite"),
    version: "rated",
    retainFrom: null
  });
  importEnglishRelease(production, rated.path);

  const legacy = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    out: join(root, "legacy.sqlite"),
    version: "legacy",
    retainFrom: null
  });
  const file = new Database(legacy.path);
  file.exec("drop table en_entry_levels");
  file.close();

  expect(importEnglishRelease(production, legacy.path)).toBe(true);
  const db = new Database(production, { readonly: true });
  expect(db.query<{ count: number }, []>("select count(*) as count from en_entry_levels").get()?.count).toBe(0);
  db.close();
});

test("a deploy migrates an en-2 production store so its lookups serve before levels are imported", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-levels-migrate-"));
  const production = join(root, "yori.sqlite");
  migrateProductionDatabase(production);
  const release = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    out: join(root, "english.sqlite"),
    version: "test",
    retainFrom: null
  });
  importEnglishRelease(production, release.path);
  const journal = await Bun.file("drizzle/meta/_journal.json").json() as {
    entries: Array<{ tag: string; when: number }>;
  };
  const en3 = journal.entries.find(({ tag }) => tag === "0007_english-entry-levels")!.when;
  const legacy = new Database(production);
  legacy.exec("drop table en_entry_levels");
  legacy.prepare("delete from __drizzle_migrations where created_at >= ?").run(en3);
  legacy.close();

  migrateProductionDatabase(production);
  const migrated = new Database(production, { readonly: true });
  expect(migrated.query<{ name: string }, []>(
    "select name from sqlite_master where type = 'table' and name = 'en_entry_levels'"
  ).get()).toEqual({ name: "en_entry_levels" });
  migrated.close();
  const repository = openEnglishEnrichmentRepository(production);
  try {
    expect(repository.find("run", "en")).toMatchObject({ headword: "run" });
    expect(repository.find("run", "en")).not.toHaveProperty("estimatedLevel");
  } finally {
    repository.close();
  }
});

async function levelSources(root: string): Promise<EnglishLevelSourceInput[]> {
  await Bun.write(join(root, "cefrj.csv"), cefrj);
  await Bun.write(join(root, "octanove.csv"), octanove);
  return [
    {
      source: "cefr-j",
      version: "1.5",
      file: join(root, "cefrj.csv"),
      license: "LicenseRef-CEFR-J-Wordlist",
      attribution: "The CEFR-J Wordlist Version 1.5"
    },
    {
      source: "octanove",
      version: "1.0",
      file: join(root, "octanove.csv"),
      license: "CC-BY-SA-4.0",
      attribution: "Octanove Vocabulary Profile C1/C2"
    }
  ];
}

async function fixtureWordNet(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "wordnet.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        run: { n: { sense: [{ id: "run%1:04:00::", synset: "s-run" }] } },
        colour: { n: { sense: [{ id: "colour%1:07:00::", synset: "s-colour" }] } },
        timid: { a: { sense: [{ id: "timid%3:00:00::", synset: "s-timid" }] } },
        ubiquitous: { a: { sense: [{ id: "ubiquitous%3:00:00::", synset: "s-ubiquitous" }] } }
      })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "s-run": { definition: ["a score in baseball"], members: ["run"], partOfSpeech: "n" },
        "s-colour": { definition: ["a visual attribute of things"], members: ["colour"], partOfSpeech: "n" }
      })
    },
    {
      name: "adj.fixture.json",
      content: JSON.stringify({
        "s-timid": { definition: ["showing a lack of courage"], members: ["timid"], partOfSpeech: "a" },
        "s-ubiquitous": { definition: ["being present everywhere at once"], members: ["ubiquitous"], partOfSpeech: "a" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2025-fixture", file };
}
