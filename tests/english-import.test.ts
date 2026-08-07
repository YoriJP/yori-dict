import { expect, test } from "bun:test";
import {
  importOpenEnglishWordNet,
  importWiktionaryEntry
} from "../src/english-import";

test("Open English WordNet import preserves synset identity, labels, and examples", () => {
  const records = importOpenEnglishWordNet({
    "08420278-n": {
      definition: ["a financial institution that accepts deposits"],
      domain_topic: ["finance"],
      example: ["She deposited the cheque at the bank."],
      ili: "i81520",
      members: ["bank", "depository financial institution"],
      partOfSpeech: "n"
    }
  }, "2025");

  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    source: "open-english-wordnet",
    sourceVersion: "2025",
    sourceEntryId: "08420278-n:bank",
    license: "CC-BY-4.0",
    headword: "bank",
    pronunciations: [],
    senses: [{
      evidenceId: "open-english-wordnet:08420278-n:bank:1",
      partOfSpeech: "noun",
      domains: ["finance"],
      definition: "a financial institution that accepts deposits",
      examples: [{
        text: "She deposited the cheque at the bank.",
        source: "sourced",
        sourceId: "08420278-n:example:1",
        reviewStatus: "source"
      }]
    }]
  });
  expect(Object.isFrozen(records[0])).toBe(true);
  expect(Object.isFrozen(records[0].senses[0])).toBe(true);
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
