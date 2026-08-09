import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEnglishLookupTerm, openEnglishLookupDb } from "../src/english-dictionary";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import { rebuildEnglishDictionary, type EnglishSourceInput } from "../src/english-rebuild";
import { migrateProductionDatabase } from "../src/production-database";
import { createStoredZip, openZipArchive } from "../src/stored-zip";
import type { EnglishEntry } from "../src/english-types";

const pinnedArchive = "sources/english/raw/english-wordnet-2025-json.zip";

test("Open English WordNet is the primary inventory and keeps its lexical-entry order", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-primary-"));
  const out = join(root, "english.sqlite");
  const result = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    out,
    version: "test",
    retainFrom: null
  });

  expect(result.coverage.en.entries).toBe(3);
  expect(result.primary.senses).toBe(6);
  expect(result.fallback).toEqual({ entries: 0, senses: 0, referenceOnly: 0 });

  const db = new Database(out, { readonly: true });
  // Every sense declares exactly one explanation language, and no gloss row
  // carries a language of its own that could disagree with it.
  expect(db.query<{ count: number }, []>("select count(*) as count from en_senses where lang is null").get()?.count).toBe(0);
  expect(db.query<{ name: string }, []>("select name from pragma_table_info('en_glosses') where name = 'lang'").all())
    .toEqual([]);

  // The archive lists bank's noun senses as slope then financial institution,
  // and the entry key `bank` before `Bank`. Neither source name nor synset id
  // decides the order.
  expect(db.query<{ position: number; source_ref: string; text: string }, []>(`
    select sense.position, sense.source_ref, gloss.text
      from en_senses sense
      join en_glosses gloss on gloss.sense_id = sense.id
      join en_entries entry on entry.id = sense.entry_id
     where entry.lookup_term = 'bank'
     order by sense.position
  `).all()).toEqual([
    { position: 1, source_ref: "open-english-wordnet:bank%1:17:01::", text: "sloping land beside water" },
    { position: 2, source_ref: "open-english-wordnet:bank%1:14:00::", text: "a financial institution that accepts deposits" },
    { position: 3, source_ref: "open-english-wordnet:bank%2:40:00::", text: "put into a bank account" },
    { position: 4, source_ref: "open-english-wordnet:bank%1:14:01::", text: "an arrangement of similar objects in a row" }
  ]);
  // A domain topic is a synset reference in the archive; it is resolved to its
  // own label rather than published as an opaque identifier.
  expect(db.query<{ domains: string }, []>(
    "select domains from en_senses where source_ref = 'open-english-wordnet:bank%1:14:00::'"
  ).get()?.domains).toBe(JSON.stringify(["finance"]));
  // Casing only survives when the sources never write the plain spelling.
  expect(db.query<{ headword: string }, []>(
    "select headword from en_entries where lookup_term = 'cpu'"
  ).get()?.headword).toBe("CPU");
  db.close();

  const lookup = openEnglishLookupDb(out);
  const entry = lookup.lookup("BANK", "en")!;
  expect(entry.headword).toBe("bank");
  expect(entry.senses.map(({ partOfSpeech }) => partOfSpeech)).toEqual(["noun", "noun", "verb", "noun"]);
  expect(entry.senses[0].examples).toEqual([{
    text: "They walked along the bank.",
    source: "sourced",
    sourceName: "open-english-wordnet",
    sourceId: "s-slope:example:1",
    reviewStatus: "source"
  }]);
  expect(entry.pronunciations).toEqual([
    { ipa: "bæŋk", source: "open-english-wordnet", sourceRef: "open-english-wordnet:bank:n:pronunciation:1" }
  ]);
  // An alternate written form the source lists still finds the entry.
  expect(lookup.lookup("banked", "en")?.id).toBe(entry.id);
  // English content is authored in English only until a later language slice.
  expect(lookup.lookup("bank", "zh-tw")).toBeNull();
  lookup.close();
});

test("Simple English Wiktionary is fallback and reference, never a semantic merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-fallback-"));
  const out = join(root, "english.sqlite");
  const result = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root), await fixtureWiktionary(root)],
    out,
    version: "test",
    retainFrom: null
  });

  expect(result.fallback).toMatchObject({ entries: 2, senses: 2, referenceOnly: 2 });

  const db = new Database(out, { readonly: true });
  // A headword the primary source covers keeps only primary senses: the
  // fallback wording is reference content, not a canonical sense.
  expect(db.query<{ source_name: string }, []>(`
    select distinct sense.source_name from en_senses sense
      join en_entries entry on entry.id = sense.entry_id
     where entry.lookup_term = 'bank'
  `).all()).toEqual([{ source_name: "open-english-wordnet" }]);
  // A headword the primary source does not carry falls back wholesale.
  expect(db.query<{ source: string }, []>(
    "select source from en_entries where lookup_term = 'selfie'"
  ).get()?.source).toBe("wiktionary");
  // A word form is refused as an entry, on the source's own categorisation of
  // the sense. A dictionary contains lexemes, not word forms.
  expect(db.query<{ count: number }, []>(
    "select count(*) as count from en_entries where lookup_term = 'banks'"
  ).get()?.count).toBe(0);
  // Nothing declares `his` a form, so nothing may delete it. Stripping the
  // headword as a second gate would, because `hi` is a covered lemma — and a
  // reader looking `his` up would then be answered with a greeting.
  expect(db.query<{ source: string }, []>(
    "select source from en_entries where lookup_term = 'his'"
  ).get()?.source).toBe("wiktionary");
  db.close();

  const lookup = openEnglishLookupDb(out);
  // Looking the surface up reaches the lemma's entry instead of dead-ending on
  // a stub that only says it is a plural. The headword is the lemma.
  const banks = lookup.lookup("banks", "en")!;
  expect(banks.headword).toBe("bank");
  expect(banks.senses.map((sense) => sense.glosses[0].text))
    .toEqual(lookup.lookup("bank", "en")!.senses.map((sense) => sense.glosses[0].text));
  // And the lexeme answers for itself rather than resolving away.
  expect(lookup.lookup("his", "en")?.headword).toBe("his");

  const selfie = lookup.lookup("selfie", "en")!;
  expect(selfie.senses[0].glosses[0]).toEqual({
    text: "a photograph you take of yourself",
    source: "wiktionary",
    reviewStatus: "source"
  });
  // An imported example with an exact sense mapping is retained.
  expect(selfie.senses[0].examples.map(({ text }) => text)).toEqual(["She posted a selfie."]);
  // A fallback pronunciation only ever fills a gap the primary entry left.
  expect(lookup.lookup("CPU", "en")?.pronunciations).toEqual([
    { ipa: "/siːpiːjuː/", region: "US", source: "wiktionary", sourceRef: "wiktionary:en:CPU:noun:1:pronunciation:1" }
  ]);
  expect(lookup.lookup("bank", "en")?.pronunciations.map(({ source }) => source)).toEqual(["open-english-wordnet"]);
  lookup.close();
});

test("a secondary canonical sense requires an exact evidence identifier", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-secondary-"));
  const mappings = join(root, "secondary.jsonl");
  await writeFile(mappings, [
    // Exact identifier of a fallback sense: admitted after the primary ones.
    JSON.stringify({ evidenceId: "wiktionary:en:bank:noun:1:1" }),
    // No such evidence in the pinned sources: never published.
    JSON.stringify({ evidenceId: "wiktionary:en:bank:noun:9:1" })
  ].join("\n"));

  const out = join(root, "english.sqlite");
  const result = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root), await fixtureWiktionary(root)],
    out,
    version: "test",
    secondaryMappings: [mappings],
    retainFrom: null
  });
  expect(result.secondary).toEqual({ imported: 1, droppedUnknownEvidence: 1 });

  const lookup = openEnglishLookupDb(out);
  const bank = lookup.lookup("bank", "en")!;
  expect(bank.senses.map((sense) => sense.glosses[0].text).at(-1)).toBe("the place where you keep money");
  expect(bank.senses.at(-1)).toMatchObject({
    position: 5,
    provenance: "source",
    evidenceIds: ["wiktionary:en:bank:noun:1:1"],
    source: { name: "wiktionary" }
  });
  expect([...new Set(bank.sources.map(({ source }) => source))]).toEqual(["open-english-wordnet", "wiktionary"]);
  lookup.close();
});

test("a rebuild retains accepted generated content and does not reorder imported senses", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-retain-"));
  const out = join(root, "english.sqlite");
  const sources = [await fixtureWordNet(root)];
  await rebuildEnglishDictionary({ sources, out, version: "test", retainFrom: null });
  migrateProductionDatabase(out);

  const repository = openEnglishEnrichmentRepository(out);
  repository.saveEntry(generatedEntry(), "en", generation);
  const imported = repository.find("bank", "en")!;
  // The usual shape of accepted enrichment: a whole language group authored
  // for an entry the pinned source provides.
  repository.saveEntry({
    ...imported,
    senses: [{
      id: "yori:en:s_generated_bank_ja:1",
      lang: "ja",
      position: 1,
      partOfSpeech: "noun",
      glosses: [{ text: "川岸", source: "generated", reviewStatus: "checked" }],
      registers: [], regions: [], domains: [], dated: false, usage: [],
      examples: [],
      evidenceIds: [],
      provenance: "generated",
      generation
    }]
  }, "ja", generation);
  const importedSenseId = imported.senses[0].id;
  repository.saveExample(importedSenseId, {
    text: "The river bank was steep.",
    source: "generated",
    reviewStatus: "checked"
  }, generation);
  repository.close();

  const result = await rebuildEnglishDictionary({ sources, out, version: "test" });
  expect(result.retained).toEqual({ entries: 1, groups: 1, examples: 1 });

  const lookup = openEnglishLookupDb(out);
  const generated = lookup.lookup("florp", "en")!;
  expect(generated.senses[0].glosses[0].text).toBe("a fictional test object");
  expect(generated.senses[0].generation).toMatchObject({ model: "gpt-5.6-luna", reviewOutcome: "accepted" });
  const bank = lookup.lookup("bank", "en")!;
  // A generated addition never renumbers or rewrites imported senses.
  expect(bank.senses[0].position).toBe(1);
  expect(bank.senses[0].provenance).toBe("source");
  expect(bank.senses[0].examples.map(({ source }) => source)).toEqual(["sourced", "generated"]);
  // The accepted language group on an imported entry survived the rebuild with
  // its own provenance, under that entry's own identity.
  const japanese = lookup.lookup("bank", "ja")!;
  expect(japanese.id).toBe(bank.id);
  expect(japanese.senses.map((sense) => sense.glosses[0].text)).toEqual(["川岸"]);
  expect(japanese.senses[0].provenance).toBe("generated");
  lookup.close();
});

test("a retained headword the sources explain as an inflection is dropped, not carried", async () => {
  // The authoring guard reads the lexicon as it stood at the time, so a word
  // form that was an entry then could be minted as a headword — `crumbling`
  // was. Retaining it whole would make one leak permanent, outliving every
  // rebuild that fixed the reason for it.
  const root = mkdtempSync(join(tmpdir(), "yori-en-retain-form-"));
  const out = join(root, "english.sqlite");
  const sources = [await fixtureWordNet(root)];
  await rebuildEnglishDictionary({ sources, out, version: "test", retainFrom: null });
  migrateProductionDatabase(out);

  const repository = openEnglishEnrichmentRepository(out);
  const form = generatedEntry();
  repository.saveEntry({
    ...form,
    id: "yori:en:e_generated_form",
    headword: "banking",
    senses: form.senses.map((sense) => ({ ...sense, id: "yori:en:s_generated_form" }))
  }, "en", generation);
  // A genuinely new lexeme reaches no lemma and is retained as before, so the
  // rule separates the two rather than distrusting generated entries.
  repository.saveEntry(generatedEntry(), "en", generation);
  repository.close();

  const result = await rebuildEnglishDictionary({ sources, out, version: "test" });
  expect(result.retained.entries).toBe(1);

  const lookup = openEnglishLookupDb(out);
  expect(lookup.lookup("florp", "en")).not.toBeNull();
  // `banking` is gone as a headword, and the surface now strips to the lexeme
  // the sources do explain.
  expect(lookup.lookup("banking", "en")?.headword).toBe("bank");
  lookup.close();
});

test("a headword the sources start providing keeps the groups it was enriched with", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-promote-"));
  const out = join(root, "english.sqlite");
  await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)], out, version: "test", retainFrom: null
  });
  migrateProductionDatabase(out);

  const repository = openEnglishEnrichmentRepository(out);
  repository.saveEntry(generatedEntry(), "en", generation);
  const florp = repository.find("florp", "en")!;
  repository.saveEntry({
    ...florp,
    senses: [{
      id: "yori:en:s_generated_florp_ja",
      lang: "ja",
      position: 1,
      partOfSpeech: "noun",
      glosses: [{ text: "架空の試験用の物。", source: "generated", reviewStatus: "checked" }],
      registers: [], regions: [], domains: [], dated: false, usage: [],
      examples: [],
      evidenceIds: [],
      provenance: "generated",
      generation
    }]
  }, "ja", generation);
  repository.close();

  // The next pinned source carries the headword the dictionary had authored.
  await rebuildEnglishDictionary({ sources: [await fixtureWordNetWithFlorp(root)], out, version: "test" });

  const lookup = openEnglishLookupDb(out);
  const english = lookup.lookup("florp", "en")!;
  // The source owns the English group now; it is not left marked generated.
  expect(english.senses.map((sense) => sense.glosses[0].text)).toEqual(["a small imaginary widget"]);
  expect(english.senses[0].provenance).toBe("source");
  // The accepted Japanese group is not source content, so it moved onto the
  // entry the source now provides instead of disappearing with the old row.
  const japanese = lookup.lookup("florp", "ja")!;
  expect(japanese.id).toBe(english.id);
  expect(japanese.senses.map((sense) => sense.glosses[0].text)).toEqual(["架空の試験用の物。"]);
  expect(japanese.senses[0].provenance).toBe("generated");
  lookup.close();
});

test("a failed rebuild leaves the previous database usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-failure-"));
  const out = join(root, "english.sqlite");
  const sources = [await fixtureWordNet(root)];
  await rebuildEnglishDictionary({ sources, out, version: "test", retainFrom: null });

  await expect(rebuildEnglishDictionary({
    sources: [{ ...sources[0], file: join(root, "missing.zip") }],
    out,
    version: "test"
  })).rejects.toThrow();

  const lookup = openEnglishLookupDb(out);
  expect(lookup.lookup("bank", "en")?.headword).toBe("bank");
  lookup.close();
  expect((await Array.fromAsync(new Bun.Glob("*.tmp").scan({ cwd: root }))).length).toBe(0);
});

test("rebuilding twice from the pinned archive is byte-identical in the source's own order", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-pinned-"));
  const sources: EnglishSourceInput[] = [
    { source: "open-english-wordnet", version: "2025", file: pinnedArchive }
  ];
  const options = { sources, version: "pinned-test", wordnetEntryFiles: ["entries-x.json"], retainFrom: null };
  const first = await rebuildEnglishDictionary({ ...options, out: join(root, "first.sqlite") });
  const second = await rebuildEnglishDictionary({ ...options, out: join(root, "second.sqlite") });

  expect(first.coverage).toEqual(second.coverage);
  expect(await bytes(first.path)).toEqual(await bytes(second.path));

  // `xylophone` is one sense; `x-ray` is several, and the archive lists them in
  // an order that is neither alphabetical by gloss nor sorted by synset id.
  const db = new Database(first.path, { readonly: true });
  const senses = db.query<{ position: number; source_ref: string }, []>(`
    select sense.position, sense.source_ref from en_senses sense
      join en_entries entry on entry.id = sense.entry_id
     where entry.lookup_term = 'x-ray' order by sense.position
  `).all();
  db.close();
  expect(senses.length).toBeGreaterThan(1);
  expect(senses.map(({ source_ref }) => source_ref)).toEqual(oewnSenseOrder("entries-x.json", "x-ray"));
}, 60_000);

/** Reads the archive's own sense order for one entry, straight from the source. */
function oewnSenseOrder(file: string, headword: string): string[] {
  const archive = openZipArchive(new Uint8Array(readFileSync(pinnedArchive)));
  const document = JSON.parse(archive.text(file)) as
    Record<string, Record<string, { sense?: Array<{ id: string }> }>>;
  return Object.entries(document)
    .filter(([key]) => normalizeEnglishLookupTerm(key) === headword)
    .flatMap(([, entry]) => Object.values(entry).flatMap((block) =>
      (block.sense ?? []).map((sense) => `open-english-wordnet:${sense.id}`)));
}

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
          },
          v: { form: ["banked"], sense: [{ id: "bank%2:40:00::", synset: "s-deposit" }] }
        },
        Bank: { n: { sense: [{ id: "bank%1:14:01::", synset: "s-row" }] } },
        CPU: { n: { sense: [{ id: "cpu%1:06:00::", synset: "s-cpu" }] } },
        // The lemma `his` strips to. Its presence is what makes the fallback
        // fixture able to prove `his` survives.
        hi: { n: { sense: [{ id: "hi%1:10:00::", synset: "s-hi" }] } }
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
          domain_topic: ["s-domain-finance"],
          members: ["bank"],
          partOfSpeech: "n"
        },
        "s-domain-finance": { definition: ["the business of banking"], members: ["finance"], partOfSpeech: "n" },
        "s-row": { definition: ["an arrangement of similar objects in a row"], members: ["bank"], partOfSpeech: "n" },
        "s-cpu": { definition: ["central processing unit"], members: ["CPU"], partOfSpeech: "n" },
        "s-hi": { definition: ["an expression of greeting"], members: ["hi"], partOfSpeech: "n" }
      })
    },
    {
      name: "verb.fixture.json",
      content: JSON.stringify({
        "s-deposit": { definition: ["put into a bank account"], members: ["bank", "deposit"], partOfSpeech: "v" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2025-fixture", file };
}

/** The pinned source, once it starts carrying the previously authored headword. */
async function fixtureWordNetWithFlorp(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "wordnet-florp.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({ florp: { n: { sense: [{ id: "florp%1:06:00::", synset: "s-florp" }] } } })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "s-florp": { definition: ["a small imaginary widget"], members: ["florp"], partOfSpeech: "n" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2025-fixture", file };
}

async function fixtureWiktionary(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "simple.jsonl");
  await writeFile(file, [
    JSON.stringify({
      word: "bank", lang_code: "en", pos: "noun",
      senses: [{ glosses: ["the place where you keep money"] }],
      sounds: [{ ipa: "/bæŋk/", tags: ["UK"] }]
    }),
    JSON.stringify({
      word: "CPU", lang_code: "en", pos: "noun",
      senses: [{ glosses: ["the processor of a computer"] }],
      sounds: [{ ipa: "/siːpiːjuː/", tags: ["US"] }]
    }),
    // Wiktionary has one page per orthographic string, so an inflected surface
    // arrives with its own definition. It is a word form, not a lexeme, and
    // the source says so by categorising the sense, as every real form page
    // does.
    JSON.stringify({
      word: "banks", lang_code: "en", pos: "noun",
      senses: [{ glosses: ["plural of bank; more than one bank"], categories: ["Plurals"] }]
    }),
    // A lexeme the primary inventory lacks, whose surface happens to strip to
    // one it carries. Nothing declares it a form, so it is a word: `his` must
    // not be deleted merely because `hi` exists.
    JSON.stringify({
      word: "his", lang_code: "en", pos: "det",
      senses: [{ glosses: ["belonging to him"], categories: ["Determiners"] }]
    }),
    JSON.stringify({
      word: "selfie", lang_code: "en", pos: "noun",
      senses: [{ glosses: ["a photograph you take of yourself"], examples: [{ text: "She posted a selfie." }] }],
      sounds: [{ ipa: "/ˈsɛlfi/", tags: ["US"] }]
    })
  ].join("\n"));
  return { source: "wiktionary", version: "2026-07-06-fixture", file };
}

const generation = {
  model: "gpt-5.6-luna",
  provider: "openrouter",
  reasoningEffort: "minimal",
  promptVersion: "english-entry-author-v2",
  serviceTier: "flex",
  reviewOutcome: "accepted",
  createdAt: "2026-08-08T00:00:00.000Z"
};

function generatedEntry(): EnglishEntry {
  return {
    id: "yori:en:e_generated_rebuild_test",
    dictionary: "en",
    headword: "florp",
    pronunciations: [],
    sources: [],
    senses: [{
      id: "yori:en:s_generated_rebuild_test",
      lang: "en",
      position: 1,
      partOfSpeech: "noun",
      glosses: [{ text: "a fictional test object", source: "generated", reviewStatus: "checked" }],
      registers: [], regions: [], domains: [], dated: false, usage: [],
      examples: [],
      evidenceIds: [],
      provenance: "generated",
      generation
    }]
  };
}
