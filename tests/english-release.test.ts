import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnglishRelease } from "../src/english-release";
import { rebuildEnglishDictionary, type EnglishSourceInput } from "../src/english-rebuild";
import { createStoredZip } from "../src/stored-zip";

test("the English release is deterministic and keeps the source's meaning order end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-release-"));
  const sources = [await fixtureWordNet(root), await fixtureWiktionary(root)];
  const first = await rebuildEnglishDictionary({ sources, out: join(root, "first.sqlite"), version: "2026.08.1", retainFrom: null });
  const second = await rebuildEnglishDictionary({ sources, out: join(root, "second.sqlite"), version: "2026.08.1", retainFrom: null });

  const firstRelease = await buildEnglishRelease(first.path, { outputDirectory: join(root, "first-release") });
  const secondRelease = await buildEnglishRelease(second.path, { outputDirectory: join(root, "second-release") });

  expect(await bytes(firstRelease.jsonl)).toEqual(await bytes(secondRelease.jsonl));
  expect(await bytes(firstRelease.sqlite)).toEqual(await bytes(secondRelease.sqlite));
  expect(await bytes(firstRelease.yomitan.en)).toEqual(await bytes(secondRelease.yomitan.en));

  // One Yomitan pack per explanation language, named for that language.
  expect(Object.keys(firstRelease.yomitan)).toEqual(["en"]);

  const manifest = await Bun.file(firstRelease.manifest).json();
  expect(manifest).toMatchObject({
    dictionary: "en",
    artifactVersion: "2026.08.1",
    schemaVersion: "en-1",
    dictionaryVersion: "2026.08.1",
    entries: 3,
    sourcePolicy: {
      primary: "open-english-wordnet",
      fallback: "wiktionary",
      secondary: "exact evidence identifier mappings only"
    },
    coverage: { en: { entries: 3, meanings: 5, glosses: 5, examples: 1 } },
    yomitan: { en: "yori-en-en.zip" }
  });
  expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(manifest.sources).toEqual([
    {
      source: "open-english-wordnet",
      lang: "en",
      version: "2025-fixture",
      license: "CC-BY-4.0",
      attribution: "Open English WordNet contributors",
      file: sources[0].file,
      sha256: "oewn-fixture-checksum",
      role: "primary"
    },
    {
      source: "wiktionary",
      lang: "en",
      version: "2026-07-06-fixture",
      license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later",
      attribution: "Simple English Wiktionary contributors; extracted with Wiktextract",
      file: sources[1].file,
      sha256: "simple-fixture-checksum",
      role: "fallback"
    }
  ]);
  expect((await Bun.file(firstRelease.checksum).text()).trim())
    .toBe(`${manifest.sha256}  ${manifest.artifact}`);

  // A release carries the canonical English tables and nothing else.
  const released = new Database(firstRelease.sqlite, { readonly: true });
  expect(released.query<{ name: string }, []>(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
  ).all().map(({ name }) => name)).toEqual([
    "en_entries", "en_entry_sources", "en_examples", "en_generations",
    "en_glosses", "en_lookup_terms", "en_metadata", "en_pronunciations", "en_senses"
  ]);
  released.close();

  const records = (await Bun.file(firstRelease.jsonl).text())
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const bank = records.find((record) => record.headword === "bank")!;
  expect(Object.keys(bank.languages)).toEqual(["en"]);
  expect(bank.languages.en.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(["sloping land beside water", "a financial institution that accepts deposits"]);
  // Concise provenance and selected text, never a complete raw source payload.
  expect(bank.languages.en.meanings[0]).toMatchObject({
    lang: "en",
    provenance: "source",
    sources: ["open-english-wordnet:bank%1:17:01::"],
    source: { name: "open-english-wordnet", version: "2025-fixture", ref: "open-english-wordnet:bank%1:17:01::" }
  });
  expect(JSON.stringify(bank)).not.toContain("rawRecord");

  const index = JSON.parse(await Bun.$`unzip -p ${firstRelease.yomitan.en} index.json`.text());
  const terms = JSON.parse(await Bun.$`unzip -p ${firstRelease.yomitan.en} term_bank_1.json`.text());
  expect(index).toMatchObject({ title: "Yori English–English", format: 3, revision: "2026.08.1" });
  const bankTerm = terms.find((term: unknown[]) => term[0] === "bank")!;
  expect(bankTerm.slice(0, 5)).toEqual(["bank", "", "noun", "", 0]);
  // The adapter reads the canonical order; it never re-sorts the meanings.
  expect(bankTerm[5]).toEqual([
    "sloping land beside water",
    "a financial institution that accepts deposits"
  ]);
});

async function bytes(path: string): Promise<number[]> {
  return Array.from(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

async function fixtureWordNet(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "wordnet.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        bank: {
          n: {
            pronunciation: [{ value: "bæŋk" }],
            sense: [{ id: "bank%1:17:01::", synset: "s-slope" }, { id: "bank%1:14:00::", synset: "s-finance" }]
          }
        },
        ledger: { n: { sense: [{ id: "ledger%1:10:00::", synset: "s-ledger" }] } }
      })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "s-slope": {
          definition: ["sloping land beside water"],
          example: ["They walked along the bank."],
          members: ["bank"],
          partOfSpeech: "n"
        },
        "s-finance": {
          definition: ["a financial institution that accepts deposits"],
          members: ["bank"],
          partOfSpeech: "n"
        },
        "s-ledger": { definition: ["a book of accounts"], members: ["ledger"], partOfSpeech: "n" }
      })
    }
  ]));
  return {
    source: "open-english-wordnet",
    version: "2025-fixture",
    file,
    sha256: "oewn-fixture-checksum"
  };
}

async function fixtureWiktionary(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "simple.jsonl");
  await writeFile(file, [
    JSON.stringify({
      word: "selfie", lang_code: "en", pos: "noun",
      senses: [
        { glosses: ["a photograph you take of yourself"] },
        { glosses: ["the act of taking such a photograph"] }
      ]
    })
  ].join("\n"));
  return {
    source: "wiktionary",
    version: "2026-07-06-fixture",
    file,
    sha256: "simple-fixture-checksum"
  };
}
