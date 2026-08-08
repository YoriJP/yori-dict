import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openLookupDb, type LookupDb } from "../src/db";
import {
  openEnglishEnrichmentRepository,
  type PersistentEnglishEnrichmentRepository
} from "../src/english-enrichment-repository";
import { buildEnglishRelease } from "../src/english-release";
import { rebuildEnglishDictionary, type EnglishSourceInput } from "../src/english-rebuild";
import {
  createEnglishOnDemandDictionary,
  createOnDemandDictionary,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from "../src/on-demand-dictionary";
import { importEnglishRelease, migrateProductionDatabase } from "../src/production-database";
import { createStoredZip } from "../src/stored-zip";

/**
 * Responses are scripted per role because examples for different meanings are
 * generated concurrently. Any unscripted call fails the test, so public lookup
 * cannot spend.
 */
class ScriptedGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  responses = new Map<string, string[]>();

  script(role: string, ...texts: string[]): void {
    this.responses.set(role, [...(this.responses.get(role) ?? []), ...texts]);
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const text = this.responses.get(request.role)?.shift();
    if (text === undefined) throw new Error(`Unscripted ${request.role} model call`);
    return {
      text,
      requestId: `request-${this.calls.length}`,
      model: request.model,
      provider: "scripted",
      effectiveServiceTier: request.requestedServiceTier,
      inputTokens: 1,
      outputTokens: 1
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.responses.clear();
  }

  roles(): string[] {
    return this.calls.map(({ role }) => role);
  }
}

const gateway = new ScriptedGateway();
let dbPath: string;
let root: string;
let sources: EnglishSourceInput[];
let lookupDb: LookupDb;
let repository: PersistentEnglishEnrichmentRepository;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "yori-en-enrich-"));
  dbPath = join(root, "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`.quiet();
  migrateProductionDatabase(dbPath);

  sources = [await fixtureWordNet(root), await fixtureWiktionary(root)];
  const rebuilt = await rebuildEnglishDictionary({
    sources,
    out: join(root, "english.sqlite"),
    version: "2026.08.1",
    retainFrom: null
  });
  expect(importEnglishRelease(dbPath, rebuilt.path)).toBe(true);
  expect(importEnglishRelease(dbPath, rebuilt.path)).toBe(false);

  lookupDb = openLookupDb(dbPath);
  repository = openEnglishEnrichmentRepository(dbPath);
  app = createApp(lookupDb, {
    enrichmentToken: "owner-token",
    englishLookup: (query, lang) => repository.find(query, lang),
    onDemand: createOnDemandDictionary({
      japanese: { resolve: async () => null },
      english: createEnglishOnDemandDictionary({
        repository,
        modelGateway: gateway,
        models: { author: "test/english-author", reviewer: "test/english-reviewer" }
      })
    })
  });
});

afterAll(() => {
  repository.close();
  lookupDb.close();
});

async function enrich(query: string) {
  const response = await app.request(
    `/v1/lookup?q=${encodeURIComponent(query)}&dictionary=en&lang=en&enrich=true`,
    { headers: { authorization: "Bearer owner-token" } }
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function read(query: string) {
  const response = await app.request(`/v1/lookup?q=${encodeURIComponent(query)}&dictionary=en&lang=en`);
  expect(response.status).toBe(200);
  return response.json();
}

function authored(definitions: string[]): string {
  return JSON.stringify({
    headword: "florp",
    pronunciations: [],
    senses: definitions.map((definition) => ({
      partOfSpeech: "noun",
      definition,
      registers: [],
      regions: [],
      domains: [],
      dated: false,
      usage: [],
      evidenceIds: [],
      provenance: "generated"
    }))
  });
}

test("the released English dictionary answers lookups with zero model calls", async () => {
  gateway.reset();
  const bank = await read("BANK");
  expect(bank.dictionary).toBe("en");
  expect(bank.lang).toBe("en");
  // The complete ordered meaning group, with pronunciations and labels intact.
  expect(bank.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text)).toEqual([
    "sloping land beside water",
    "a financial institution that accepts deposits"
  ]);
  expect(bank.meanings[1]).toMatchObject({
    position: 2,
    partOfSpeech: ["noun"],
    domains: ["finance"],
    dated: false,
    provenance: "source",
    sources: ["open-english-wordnet:bank%1:14:00::"]
  });
  expect(bank.pronunciations).toEqual([{ ipa: "bæŋk" }]);

  // English-specific register, region, dated, and usage labels stay intact.
  const telly = await read("telly");
  expect(telly.meanings[0]).toMatchObject({
    registers: ["informal"],
    regions: ["UK"],
    dated: true,
    usage: ["countable"]
  });
  expect(telly.pronunciations).toEqual([{ ipa: "/ˈtɛli/", region: "UK" }]);

  expect(await read("no-such-word")).toBeNull();
  expect(gateway.calls).toEqual([]);
});

test("one author request and one reviewer fill a missing English group", async () => {
  gateway.reset();
  expect(await read("florp")).toBeNull();

  gateway.script("eligibility", "florp");
  gateway.script("entry-author", authored(["a fictional test object", "a fictional test action"]));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author",
    JSON.stringify({ sentence: "The florp sat on the table." }),
    JSON.stringify({ sentence: "She performed a florp." }));
  gateway.script("example-review", "ACCEPT", "ACCEPT");

  const entry = await enrich("florp");
  expect(entry.lang).toBe("en");
  expect(entry.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(["a fictional test object", "a fictional test action"]);
  expect(gateway.roles().filter((role) => role.startsWith("entry"))).toEqual(["entry-author", "entry-review"]);

  const published = await read("florp");
  expect(published.meanings).toHaveLength(2);
  expect(published.meanings[0]).toMatchObject({ provenance: "generated", sources: [] });
  expect(published.meanings[0].examples[0]).toMatchObject({
    text: "The florp sat on the table.",
    source: "generated",
    reviewStatus: "checked"
  });
  // Honest provenance is stored beside the accepted content.
  expect(repository.acceptedEntries("en").map(({ headword }) => headword)).toEqual(["florp"]);
  expect(repository.acceptedEntries("en")[0].senses[0].generation).toMatchObject({
    model: "test/english-author",
    promptVersion: "english-entry-author-v1",
    reviewOutcome: "accepted"
  });
  expect(repository.attemptRecords().length).toBeGreaterThan(0);
});

test("a rejected English group never becomes visible", async () => {
  gateway.reset();
  gateway.script("eligibility", "quibble");
  gateway.script("entry-author", JSON.stringify({
    headword: "quibble",
    pronunciations: [],
    senses: [{
      partOfSpeech: "noun", definition: "a small objection", registers: [], regions: [], domains: [],
      dated: false, usage: [], evidenceIds: [], provenance: "generated"
    }]
  }));
  gateway.script("entry-review", "REJECT");
  expect(await enrich("quibble")).toBeNull();
  expect(await read("quibble")).toBeNull();
  // The already accepted group is untouched.
  expect((await read("florp")).meanings).toHaveLength(2);
});

test("a rejected example keeps accepted meanings and allows one fresh later attempt", async () => {
  gateway.reset();
  gateway.script("eligibility", "blorp");
  gateway.script("entry-author", JSON.stringify({
    headword: "blorp",
    pronunciations: [],
    senses: [{
      partOfSpeech: "noun", definition: "a fictional test sound", registers: [], regions: [], domains: [],
      dated: false, usage: [], evidenceIds: [], provenance: "generated"
    }]
  }));
  gateway.script("entry-review", "ACCEPT");
  gateway.script("example-author", JSON.stringify({ sentence: "The blorp echoed." }));
  gateway.script("example-review", "REJECT");
  const rejected = await enrich("blorp");

  expect(rejected.meanings).toHaveLength(1);
  expect(rejected.meanings[0].examples).toEqual([]);
  expect((await read("blorp")).meanings[0].examples).toEqual([]);

  gateway.reset();
  gateway.script("example-author", JSON.stringify({ sentence: "The blorp echoed." }));
  gateway.script("example-review", "ACCEPT");
  const retried = await enrich("blorp");
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(retried.meanings[0].examples[0].text).toBe("The blorp echoed.");

  // Once one accepted example exists, a later owner lookup stops generating.
  gateway.reset();
  await enrich("blorp");
  expect(gateway.calls).toEqual([]);
});

test("enrichment never rewrites correct imported content", async () => {
  gateway.reset();
  const before = await read("bank");
  expect(before.meanings[0].glosses[0].text).toBe("sloping land beside water");

  gateway.script("example-author", JSON.stringify({ sentence: "She deposited her salary at the bank." }));
  gateway.script("example-review", "ACCEPT");
  const enriched = await enrich("bank");
  // Only the observable gap is filled: the first meaning already carries an
  // imported example, so only the second meaning gets a generated one.
  expect(gateway.roles()).toEqual(["example-author", "example-review"]);
  expect(enriched.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text))
    .toEqual(before.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text));
  expect(enriched.meanings[0].examples).toEqual(before.meanings[0].examples);
  expect(enriched.meanings[0].examples[0]).toMatchObject({
    text: "They walked along the bank.",
    source: "sourced",
    reviewStatus: "source"
  });
  expect(enriched.meanings[1].examples.map(({ text }: { text: string }) => text))
    .toEqual(["She deposited her salary at the bank."]);
});

test("a later release keeps accepted English content and refreshes imported meanings", async () => {
  gateway.reset();
  const rebuilt = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root, { extended: true })],
    out: join(root, "english-2.sqlite"),
    version: "2026.09.1",
    retainFrom: null
  });
  const release = await buildEnglishRelease(rebuilt.path, { outputDirectory: join(root, "release-2") });
  expect(importEnglishRelease(dbPath, release.sqlite)).toBe(true);

  // Accepted generated entries and accepted generated examples survive.
  expect((await read("florp")).meanings).toHaveLength(2);
  expect((await read("blorp")).meanings[0].examples[0].text).toBe("The blorp echoed.");
  const bank = await read("bank");
  expect(bank.meanings.map((meaning: { glosses: Array<{ text: string }> }) => meaning.glosses[0].text)).toEqual([
    "sloping land beside water",
    "a financial institution that accepts deposits",
    "an arrangement of similar objects in a row"
  ]);
  expect(bank.meanings[0].examples.map(({ text }: { text: string }) => text))
    .toEqual(["They walked along the bank."]);
  expect(bank.meanings[1].examples.map(({ text }: { text: string }) => text))
    .toEqual(["She deposited her salary at the bank."]);
  expect(gateway.calls).toEqual([]);

  const db = new Database(dbPath, { readonly: true });
  expect(db.query<{ value: string }, []>(
    "select value from en_metadata where key = 'dictionaryVersion'"
  ).get()?.value).toBe("2026.09.1");
  db.close();
});

test("canonical evidence handed to an author carries selected text, not raw payloads", async () => {
  const evidence = repository.findSources("bank");
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    source: "open-english-wordnet",
    sourceEntryId: "bank:n",
    license: "CC-BY-4.0",
    headword: "bank"
  });
  expect(evidence[0].senses[0]).toMatchObject({
    evidenceId: "open-english-wordnet:bank%1:17:01::",
    partOfSpeech: "noun",
    glosses: ["sloping land beside water"]
  });
  expect(JSON.stringify(evidence)).not.toContain("rawRecord");
});

async function fixtureWordNet(
  directory: string,
  options: { extended?: boolean } = {}
): Promise<EnglishSourceInput> {
  const file = join(directory, options.extended ? "wordnet-2.zip" : "wordnet.zip");
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        bank: {
          n: {
            pronunciation: [{ value: "bæŋk" }],
            sense: [
              { id: "bank%1:17:01::", synset: "s-slope" },
              { id: "bank%1:14:00::", synset: "s-finance" },
              ...(options.extended ? [{ id: "bank%1:14:01::", synset: "s-row" }] : [])
            ]
          }
        }
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
        "s-row": { definition: ["an arrangement of similar objects in a row"], members: ["bank"], partOfSpeech: "n" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: options.extended ? "2025-b" : "2025-a", file };
}

async function fixtureWiktionary(directory: string): Promise<EnglishSourceInput> {
  const file = join(directory, "simple.jsonl");
  await writeFile(file, JSON.stringify({
    word: "telly", lang_code: "en", pos: "noun",
    senses: [{
      glosses: ["a television set"],
      tags: ["informal", "British", "dated", "countable"]
    }],
    sounds: [{ ipa: "/ˈtɛli/", tags: ["British"] }]
  }));
  return { source: "wiktionary", version: "2026-07-06-fixture", file };
}
