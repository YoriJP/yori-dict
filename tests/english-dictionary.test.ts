import { expect, test } from "bun:test";
import {
  reconcileEnglishSourceRecords,
  validateEnglishDictionary
} from "../src/english-dictionary";
import type { EnglishSourceRecord } from "../src/english-types";

test("English reconciliation keeps independent structure and stable Yori ids", () => {
  const entries = reconcileEnglishSourceRecords([
    sourceRecord({
      source: "open-english-wordnet",
      sourceEntryId: "oewn-bank-n-1",
      partOfSpeech: "noun",
      definition: "a financial institution that accepts deposits",
      domain: ["finance"],
      pronunciation: { ipa: "/bæŋk/", region: "US" }
    }),
    sourceRecord({
      source: "wiktionary",
      sourceEntryId: "en-bank-en-noun-1",
      partOfSpeech: "noun",
      definition: "a financial institution that accepts deposits",
      domain: ["finance"],
      register: ["formal"],
      pronunciation: { ipa: "/bæŋk/", region: "US" }
    }),
    sourceRecord({
      source: "wiktionary",
      sourceEntryId: "en-bank-en-noun-2",
      partOfSpeech: "noun",
      definition: "the land alongside a river",
      region: ["UK"]
    })
  ]);

  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry.id).toMatch(/^yori:en:e_/);
  expect(entry.headword).toBe("bank");
  expect(entry.pronunciations).toEqual([{ ipa: "/bæŋk/", region: "US", evidenceIds: [
    "open-english-wordnet:oewn-bank-n-1:1",
    "wiktionary:en-bank-en-noun-1:1"
  ] }]);
  expect(entry.senses).toHaveLength(3);
  expect(entry.senses.map((sense) => sense.definition)).toEqual([
    "a financial institution that accepts deposits",
    "a financial institution that accepts deposits",
    "the land alongside a river"
  ]);
  expect(entry.senses[0]).toMatchObject({
    partOfSpeech: "noun",
    domains: ["finance"],
    registers: [],
    provenance: "source"
  });
  expect(entry.senses[1]).toMatchObject({
    registers: ["formal"],
    provenance: "source"
  });
  expect(entry.sources.map(({ source, sourceEntryId }) => `${source}:${sourceEntryId}`)).toEqual([
    "open-english-wordnet:oewn-bank-n-1",
    "wiktionary:en-bank-en-noun-1",
    "wiktionary:en-bank-en-noun-2"
  ]);
  expect(validateEnglishDictionary(entries)).toEqual([]);

  expect(reconcileEnglishSourceRecords([...entriesToRecords(entries)]).map(({ id }) => id)).toEqual([entry.id]);
});

test("English reconciliation deduplicates only truly equivalent evidence", () => {
  const equivalent = sourceRecord({
    source: "open-english-wordnet",
    sourceEntryId: "oewn-run-v-1",
    headword: "run",
    partOfSpeech: "verb",
    definition: "move fast on foot",
    register: ["informal"],
    region: ["US"],
    domain: ["sport"],
    dated: true,
    usage: ["intransitive"]
  });
  const second = sourceRecord({
    source: "wiktionary",
    sourceEntryId: "en-run-en-verb-1",
    headword: "run",
    partOfSpeech: "verb",
    definition: "move fast on foot",
    register: ["informal"],
    region: ["US"],
    domain: ["sport"],
    dated: true,
    usage: ["intransitive"]
  });

  const [entry] = reconcileEnglishSourceRecords([equivalent, second]);
  expect(entry.senses).toHaveLength(1);
  expect(entry.senses[0].evidenceIds).toEqual([
    "open-english-wordnet:oewn-run-v-1:1",
    "wiktionary:en-run-en-verb-1:1"
  ]);
  expect(entry.senses[0]).toMatchObject({
    registers: ["informal"],
    regions: ["US"],
    domains: ["sport"],
    dated: true,
    usage: ["intransitive"]
  });
});

test("English reconciliation keeps meaningful abbreviation casing", () => {
  const [entry] = reconcileEnglishSourceRecords([sourceRecord({
    source: "open-english-wordnet",
    sourceEntryId: "oewn-cpu-n-1",
    headword: "CPU",
    partOfSpeech: "noun",
    definition: "central processing unit"
  })]);

  expect(entry.headword).toBe("CPU");
  expect(entry.id).toBe(reconcileEnglishSourceRecords([sourceRecord({
    source: "open-english-wordnet",
    sourceEntryId: "oewn-cpu-n-1",
    headword: "cpu",
    partOfSpeech: "noun",
    definition: "central processing unit"
  })])[0].id);
});

function sourceRecord(input: {
  source: "open-english-wordnet" | "wiktionary";
  sourceEntryId: string;
  headword?: string;
  partOfSpeech: string;
  definition: string;
  register?: string[];
  region?: string[];
  domain?: string[];
  dated?: boolean;
  usage?: string[];
  pronunciation?: { ipa: string; region?: string };
}): EnglishSourceRecord {
  const evidenceId = `${input.source}:${input.sourceEntryId}:1`;
  return {
    source: input.source,
    sourceVersion: input.source === "open-english-wordnet" ? "2025" : "2026-07-06",
    sourceEntryId: input.sourceEntryId,
    license: input.source === "open-english-wordnet" ? "CC-BY-4.0" : "CC-BY-SA-4.0 AND GFDL-1.1-or-later",
    attribution: input.source === "open-english-wordnet" ? "Open English WordNet contributors" : "English Wiktionary contributors",
    rawRecord: { fixture: input.sourceEntryId },
    headword: input.headword ?? "bank",
    pronunciations: input.pronunciation ? [{ ...input.pronunciation, evidenceId }] : [],
    senses: [{
      evidenceId,
      partOfSpeech: input.partOfSpeech,
      definition: input.definition,
      registers: input.register ?? [],
      regions: input.region ?? [],
      domains: input.domain ?? [],
      dated: input.dated ?? false,
      usage: input.usage ?? [],
      examples: []
    }]
  };
}

function entriesToRecords(entries: ReturnType<typeof reconcileEnglishSourceRecords>): EnglishSourceRecord[] {
  return entries.flatMap((entry) => entry.sources.map((source) => ({
    source: source.source,
    sourceVersion: source.sourceVersion,
    sourceEntryId: source.sourceEntryId,
    license: source.license,
    attribution: source.attribution,
    rawRecord: { restored: source.sourceEntryId },
    headword: entry.headword,
    pronunciations: entry.pronunciations.flatMap((pronunciation) => pronunciation.evidenceIds
      .filter((id) => id.startsWith(`${source.source}:${source.sourceEntryId}:`))
      .map((evidenceId) => ({ ipa: pronunciation.ipa, region: pronunciation.region, evidenceId }))),
    senses: entry.senses.flatMap((sense) => sense.evidenceIds
      .filter((id) => id.startsWith(`${source.source}:${source.sourceEntryId}:`))
      .map((evidenceId) => ({
        evidenceId,
        partOfSpeech: sense.partOfSpeech,
        definition: sense.definition,
        registers: sense.registers,
        regions: sense.regions,
        domains: sense.domains,
        dated: sense.dated,
        usage: sense.usage,
        examples: sense.examples
      })))
  })));
}
