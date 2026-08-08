import { expect, test } from "bun:test";
import {
  importOpenEnglishWordNetEntry,
  importWiktionaryEntry
} from "../src/english-import";

const synsets: Record<string, Record<string, unknown>> = {
  "08420278-n": {
    definition: ["a financial institution that accepts deposits"],
    domain_topic: ["13333833-n"],
    example: ["She deposited the cheque at the bank."],
    ili: "i81520",
    members: ["bank", "depository financial institution"],
    partOfSpeech: "n"
  },
  "09236472-n": {
    definition: ["sloping land beside a body of water"],
    members: ["bank"],
    partOfSpeech: "n"
  },
  "13333833-n": { definition: ["the commercial activity of banking"], members: ["finance"], partOfSpeech: "n" }
};

test("Open English WordNet import keeps the lexical entry's own sense order and labels", () => {
  const records = importOpenEnglishWordNetEntry(
    "bank",
    {
      n: {
        pronunciation: [{ value: "b\u00e6\u014bk", variety: "GB" }],
        form: ["banks"],
        // The archive lists the financial sense first for this entry, even
        // though its synset identifier sorts after the other one.
        sense: [{ id: "bank%1:14:00::", synset: "08420278-n" }, { id: "bank%1:17:01::", synset: "09236472-n" }]
      }
    },
    (id) => synsets[id],
    "2025"
  );

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    source: "open-english-wordnet",
    sourceVersion: "2025",
    sourceEntryId: "bank:n",
    license: "CC-BY-4.0",
    headword: "bank",
    forms: ["banks"],
    pronunciations: [{
      ipa: "b\u00e6\u014bk",
      region: "GB",
      evidenceId: "open-english-wordnet:bank:n:pronunciation:1"
    }]
  });
  // The stable evidence identifier is the source's own sense key.
  expect(records[0].senses.map(({ evidenceId }) => evidenceId)).toEqual([
    "open-english-wordnet:bank%1:14:00::",
    "open-english-wordnet:bank%1:17:01::"
  ]);
  expect(records[0].senses[0]).toEqual({
    evidenceId: "open-english-wordnet:bank%1:14:00::",
    partOfSpeech: "noun",
    glosses: ["a financial institution that accepts deposits"],
    registers: [],
    regions: [],
    // A domain topic is a synset reference; it is resolved to its own label.
    domains: ["finance"],
    dated: false,
    usage: [],
    examples: [{
      text: "She deposited the cheque at the bank.",
      source: "sourced",
      sourceName: "open-english-wordnet",
      sourceId: "08420278-n:example:1",
      reviewStatus: "source"
    }]
  });
});

test("Open English WordNet import drops a sense whose synset has no definition", () => {
  expect(importOpenEnglishWordNetEntry(
    "florp",
    { n: { sense: [{ id: "florp%1:00:00::", synset: "missing" }] } },
    () => undefined,
    "2025"
  )).toEqual([]);
});

test("Wiktionary import keeps pronunciation and usage distinctions structured", () => {
  const records = importWiktionaryEntry({
    word: "lead",
    lang: "English",
    lang_code: "en",
    pos: "verb",
    etymology_number: 1,
    sounds: [
      { ipa: "/liːd/", tags: ["General-American"] },
      { ipa: "/lɛd/", tags: ["General-American"] }
    ],
    senses: [
      {
        glosses: ["To guide or conduct."],
        tags: ["transitive", "figuratively"],
        topics: ["management"],
        examples: [{ text: "She leads the team." }]
      },
      {
        glosses: ["To be ahead of."],
        tags: ["intransitive", "sports"],
        raw_glosses: ["(sports, intransitive) To be ahead of."]
      }
    ]
  }, "2026-07-06");

  expect(records).toHaveLength(1);
  expect(records[0].sourceEntryId).toBe("en:lead:verb:1");
  expect(records[0].pronunciations).toEqual([
    { ipa: "/liːd/", region: "US", evidenceId: "wiktionary:en:lead:verb:1:pronunciation:1" },
    { ipa: "/lɛd/", region: "US", evidenceId: "wiktionary:en:lead:verb:1:pronunciation:2" }
  ]);
  expect(records[0].senses).toEqual([
    expect.objectContaining({
      evidenceId: "wiktionary:en:lead:verb:1:1",
      glosses: ["To guide or conduct."],
      registers: ["figurative"],
      regions: [],
      domains: ["management"],
      dated: false,
      usage: ["transitive"]
    }),
    expect.objectContaining({
      registers: [],
      domains: ["sports"],
      usage: ["intransitive"]
    })
  ]);
});

test("Wiktionary import drops non-English and non-lexical records", () => {
  expect(importWiktionaryEntry({ word: "Paris", lang_code: "en", pos: "name", senses: [{ glosses: ["capital"] }] }, "v")).toEqual([]);
  expect(importWiktionaryEntry({ word: "chat", lang_code: "fr", pos: "noun", senses: [{ glosses: ["cat"] }] }, "v")).toEqual([]);
  expect(importWiktionaryEntry({ word: "https://example.com", lang_code: "en", pos: "noun", senses: [{ glosses: ["url"] }] }, "v")).toEqual([]);
});
