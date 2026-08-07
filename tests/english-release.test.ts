import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnglishRelease, openEnglishDictionary } from "../src/english-release";
import type { EnglishSourceRecord } from "../src/english-types";

test("English release builds independent reproducible SQLite, JSONL, and Yomitan v3 artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-english-release-"));
  const records = sourceRecords();
  const options = { version: "2026.08.1", createdAt: "2026-08-06T00:00:00.000Z" };
  const first = await buildEnglishRelease(records, { ...options, outputDirectory: join(root, "first") });
  const second = await buildEnglishRelease(records.reverse(), { ...options, outputDirectory: join(root, "second") });

  expect(await bytes(first.jsonl)).toEqual(await bytes(second.jsonl));
  expect(await bytes(first.sqlite)).toEqual(await bytes(second.sqlite));
  expect(await bytes(first.yomitan)).toEqual(await bytes(second.yomitan));
  expect(await Bun.file(first.manifest).json()).toMatchObject({
    dictionary: "en",
    schemaVersion: 1,
    dictionaryVersion: "2026.08.1",
    counts: { entries: 1, senses: 2, sourceRecords: 2 }
  });

  const db = new Database(first.sqlite, { readonly: true });
  const raw = db.query<{ raw_json: string; license: string }, [string]>(
    `select p.raw_json, r.license
       from source_records r
       join source_payloads p on p.source = r.source and p.payload_id = r.payload_id
      where r.source_entry_id = ?`
  ).get("oewn-bank");
  expect(JSON.parse(raw!.raw_json)).toEqual({ untouched: "oewn" });
  expect(raw!.license).toBe("CC-BY-4.0");
  expect(db.query<{ value: string }, [string]>("select value from metadata where key = ?").get("dictionaryVersion")?.value).toBe("2026.08.1");
  db.close();

  const dictionary = openEnglishDictionary(first.sqlite);
  expect(dictionary.lookup("BANK")?.headword).toBe("bank");
  expect(dictionary.lookup("missing")).toBeNull();
  dictionary.close();

  const index = JSON.parse(await Bun.$`unzip -p ${first.yomitan} index.json`.text());
  const terms = JSON.parse(await Bun.$`unzip -p ${first.yomitan} term_bank_1.json`.text());
  expect(index).toMatchObject({ title: "Yori English Dictionary", format: 3, revision: "2026.08.1" });
  expect(terms[0].slice(0, 5)).toEqual(["bank", "", "noun", "", 0]);
  expect(terms[0][5]).toEqual([
    "a financial institution that accepts deposits",
    "the land alongside a river"
  ]);
});

async function bytes(path: string): Promise<number[]> {
  return Array.from(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function sourceRecords(): EnglishSourceRecord[] {
  return [
    {
      source: "open-english-wordnet",
      sourceVersion: "2025",
      sourceEntryId: "oewn-bank",
      license: "CC-BY-4.0",
      attribution: "Open English WordNet contributors",
      rawRecord: { untouched: "oewn" },
      headword: "bank",
      pronunciations: [],
      senses: [{
        evidenceId: "open-english-wordnet:oewn-bank:1",
        partOfSpeech: "noun",
        definition: "a financial institution that accepts deposits",
        registers: [], regions: [], domains: ["finance"], dated: false, usage: [], examples: []
      }]
    },
    {
      source: "wiktionary",
      sourceVersion: "2026-07-06",
      sourceEntryId: "wiki-bank",
      license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later",
      attribution: "English Wiktionary contributors",
      rawRecord: { untouched: "wiktionary" },
      headword: "bank",
      pronunciations: [{ ipa: "/bæŋk/", evidenceId: "wiktionary:wiki-bank:pronunciation:1" }],
      senses: [{
        evidenceId: "wiktionary:wiki-bank:1",
        partOfSpeech: "noun",
        definition: "the land alongside a river",
        registers: [], regions: [], domains: [], dated: false, usage: [], examples: []
      }]
    }
  ];
}
