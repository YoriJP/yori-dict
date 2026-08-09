import { expect, test } from "bun:test";
import {
  assertImportable,
  classifySourceRecord,
  importJapaneseWordNetEvidence,
  importTaiwanTerminology,
  japaneseWordNetCorroborationIndex,
  taiwanCorroborationIndex,
  type DirectImportCandidate,
  type IliMapping,
  type JapaneseWordNetRecord,
  type TaiwanTerminologyRecord
} from "../scripts/english-evidence-sources";
import { taiwanTermPairKey } from "../scripts/english-evidence";

const wordNetMeta = {
  version: "1.1",
  license: "Japanese WordNet License (BSD-style, attribution required)",
  attribution: "Japanese WordNet, NICT",
  mappingSource: "open-multilingual-wordnet-ili",
  mappingVersion: "1.4"
};

test("admits Japanese WordNet evidence only through a validated PWN/ILI mapping", async () => {
  const records = await readJsonl<JapaneseWordNetRecord>("fixtures/english-evidence/japanese-wordnet.jsonl");
  const mappings = await readJsonl<IliMapping>("fixtures/english-evidence/japanese-wordnet-ili.jsonl");

  const imported = importJapaneseWordNetEvidence(records, mappings, wordNetMeta);

  expect(imported.accepted.map((row) => row.lemma)).toEqual(["犬", "走る", "水"]);
  expect(imported.rejected).toEqual([
    { recordId: "99999999-n:未対応語", reason: "no-princeton-wordnet-ili-mapping" },
    { recordId: "02084071-n:dog", reason: "record-is-not-japanese" },
    { recordId: "03187595-n:未検証語", reason: "princeton-wordnet-ili-mapping-is-not-validated" }
  ]);

  const dog = imported.accepted[0]!;
  expect(dog.mapping).toEqual({
    ili: "i46161",
    pwnSynset: "pwn-02084071-n",
    mappingSource: "open-multilingual-wordnet-ili",
    mappingVersion: "1.4",
    validated: true
  });
  // Japanese WordNet carries its own Japanese definitions, so a mapped record
  // is a direct-import candidate rather than mere supporting evidence.
  expect(dog.role).toBe("direct-import-candidate");
  expect(imported.meta).toMatchObject({
    source: "japanese-wordnet",
    version: "1.1",
    detail: { mappingSource: "open-multilingual-wordnet-ili", mappingVersion: "1.4" }
  });
  expect(japaneseWordNetCorroborationIndex(imported.accepted).get("犬")).toEqual({
    source: "japanese-wordnet",
    version: "1.1",
    detail: "pwn-02084071-n/i46161"
  });
});

test("a Japanese WordNet record without its own definition stays supporting evidence", () => {
  const imported = importJapaneseWordNetEvidence(
    [{ synset: "02084071-n", lemma: "犬", lang: "jpn", definition: null }],
    [{ synset: "02084071-n", ili: "i46161", pwnSynset: "pwn-02084071-n", validated: true }],
    wordNetMeta
  );

  expect(imported.accepted[0]).toMatchObject({
    role: "supporting-evidence",
    reasons: ["source-has-no-target-language-sense-structure"]
  });
});

test("Taiwan terminology keeps agency, dataset, domain, version, attribution, and the exact term pair", async () => {
  const records = await readJsonl<TaiwanTerminologyRecord>("fixtures/english-evidence/taiwan-terminology.jsonl");

  const imported = importTaiwanTerminology(records, { license: "Open Government Data License, Taiwan 1.0" });

  expect(imported.accepted).toHaveLength(2);
  expect(imported.accepted[0]).toMatchObject({
    evidenceId: "taiwan-terminology:雙語詞彙、學術名詞暨辭書資訊網:2024-03:nict-2019-000431",
    agency: "國家教育研究院",
    dataset: "雙語詞彙、學術名詞暨辭書資訊網",
    domain: "資訊科技",
    version: "2024-03",
    attribution: "國家教育研究院 雙語詞彙、學術名詞暨辭書資訊網",
    termPair: { english: "interface", chinese: "介面" },
    targetLocale: "zh-tw",
    domainSpecific: true
  });
  // A bare term pair has no Taiwanese meaning structure, so it corroborates
  // wording inside its domain without becoming canonical content.
  expect(imported.accepted[0]!.role).toBe("supporting-evidence");
  expect(imported.rejected).toEqual([
    { recordId: "nict-2019-000433", reason: "incomplete-provenance:agency" }
  ]);
  const index = taiwanCorroborationIndex(imported.accepted);
  expect(index.get(taiwanTermPairKey("interface", "介面"))).toEqual({
    source: "taiwan-terminology",
    version: "2024-03",
    detail: "國家教育研究院/雙語詞彙、學術名詞暨辭書資訊網/資訊科技"
  });
  // The dataset vouches for one term pair, not for the Chinese string alone.
  // Another English entry that happens to translate to 介面 gets no Taiwan
  // support from this row.
  expect(index.get(taiwanTermPairKey("facade", "介面"))).toBeUndefined();
});

test("reverse and Simplified Chinese sources remain supporting evidence", () => {
  for (const sourceId of ["jmdict-reverse", "cc-cedict", "chinese-wordnet-simplified", "wiktionary-en-translations"]) {
    const classification = classifySourceRecord(
      candidate({ sourceId, matchedBy: "source-identifier", hasTargetLanguageSenseStructure: true })
    );
    expect(classification.role).toBe("supporting-evidence");
    expect(classification.eligible).toBe(false);
    expect(classification.reasons).toContain("source-is-supporting-evidence-only");
  }
});

test("string and reverse-gloss matches never qualify for direct import", () => {
  for (const matchedBy of ["string-match", "reverse-gloss", "none"] as const) {
    const classification = classifySourceRecord(candidate({ sourceId: "japanese-wordnet", matchedBy }));
    expect(classification.eligible).toBe(false);
    expect(classification.reasons).toContain("match-is-not-an-exact-source-identifier-or-explicit-mapping");
  }
});

test("NTU Chinese Wordnet needs a documented permission grant before any import", () => {
  const restricted = candidate({ sourceId: "ntu-chinese-wordnet", targetLocale: "zh-tw", recordLocale: "zh-tw" });

  expect(classifySourceRecord(restricted)).toEqual({
    role: "restricted",
    eligible: false,
    reasons: ["restricted-source-requires-a-documented-permission-grant"]
  });
  expect(() => assertImportable(restricted)).toThrow(/restricted-source-requires-a-documented-permission-grant/);

  const granted = classifySourceRecord({
    ...restricted,
    permissionGrant: { document: "docs/permissions/ntu-cwn.md", grantedAt: "2026-08-01", grantedBy: "NTU CWN" }
  });
  expect(granted.eligible).toBe(true);
});

test("direct import requires meaning structure, locale, license, attribution, and provenance", () => {
  expect(classifySourceRecord(candidate({}))).toEqual({ role: "direct-import-candidate", eligible: true, reasons: [] });

  expect(classifySourceRecord(candidate({ hasTargetLanguageSenseStructure: false })).reasons).toContain(
    "source-has-no-target-language-sense-structure"
  );
  expect(classifySourceRecord(candidate({ recordLocale: "zh-hant", targetLocale: "zh-tw" })).reasons).toContain(
    "record-locale-does-not-match-the-target-locale"
  );
  expect(classifySourceRecord(candidate({ license: null })).reasons).toContain("no-recorded-redistribution-license");
  expect(classifySourceRecord(candidate({ attribution: null })).reasons).toContain("no-recorded-attribution");
  expect(classifySourceRecord(candidate({ recordId: "" })).reasons).toContain("incomplete-provenance");
});

function candidate(overrides: Partial<DirectImportCandidate>): DirectImportCandidate {
  return {
    sourceId: "japanese-wordnet",
    sourceVersion: "1.1",
    recordId: "02084071-n:犬",
    targetLocale: "ja",
    recordLocale: "ja",
    hasTargetLanguageSenseStructure: true,
    matchedBy: "explicit-mapping",
    license: wordNetMeta.license,
    attribution: wordNetMeta.attribution,
    ...overrides
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}
