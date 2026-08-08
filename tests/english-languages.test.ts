import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEnglishLookupDb } from "../src/english-dictionary";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import {
  rebuildEnglishDictionary,
  type EnglishLanguageSourceInput,
  type EnglishRebuildResult,
  type EnglishSourceInput
} from "../src/english-rebuild";
import { buildEnglishRelease, type EnglishReleaseArtifacts } from "../src/english-release";
import { migrateProductionDatabase } from "../src/production-database";
import { createStoredZip, openZipFile } from "../src/stored-zip";
import {
  createEnglishOnDemandDictionary,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from "../src/on-demand-dictionary";

const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const han = /\p{Script=Han}/u;
const hangul = /\p{Script=Hangul}/u;

/**
 * Text that could not have been written in `lang`. This is about writing
 * system, not wording: it catches the real failure mode, one language's content
 * being published under another language's name.
 */
function foreignToLanguage(lang: string, text: string): boolean {
  if (lang === "en") return kana.test(text) || han.test(text) || hangul.test(text);
  if (lang === "ja") return hangul.test(text) || !(kana.test(text) || han.test(text));
  if (lang === "zh-tw") return kana.test(text) || hangul.test(text) || !han.test(text);
  return false;
}

test("one English entry carries independent en, ja and zh-tw groups", async () => {
  const { path } = await built();
  const lookup = openEnglishLookupDb(path);

  const english = lookup.lookup("dog", "en")!;
  const japanese = lookup.lookup("dog", "ja")!;
  expect(english.id).toBe(japanese.id);
  // Same entry identity and written form; different meaning identifiers,
  // wording and provenance.
  expect(english.senses[0].id).not.toBe(japanese.senses[0].id);
  expect(english.senses.map((sense) => sense.glosses[0].text)).toEqual(["a domesticated carnivorous mammal"]);
  expect(japanese.senses.map((sense) => sense.glosses[0].text)).toEqual(["人間に古くから飼われている哺乳類。"]);
  expect(japanese.senses[0].source).toMatchObject({ name: "japanese-wordnet", version: "1.1-fixture" });

  // Each language group numbers its own meanings from 1.
  const taiwanese = lookup.lookup("interface", "zh-tw")!;
  expect(taiwanese.senses.map(({ position }) => position)).toEqual([1]);
  expect(taiwanese.senses[0].glosses[0].text).toBe("兩個系統交換訊息的共同邊界。");
  expect(taiwanese.senses[0].domains).toEqual(["資訊科技"]);

  // No fallback: a language the entry does not explain is a miss for that
  // language, never another language's meanings.
  expect(lookup.lookup("interface", "ja")).toBeNull();
  expect(lookup.lookup("network", "ja")).toBeNull();
  expect(lookup.lookup("network", "zh-tw")).toBeNull();
  expect(lookup.lookup("network", "en")).not.toBeNull();

  // An authored group divides meanings its own way: English has one meaning
  // for ledger, Taiwanese Chinese has two, and none of them share identifiers.
  const authored = lookup.lookup("ledger", "zh-tw")!;
  expect(lookup.lookup("ledger", "en")!.senses).toHaveLength(1);
  expect(authored.senses.map((sense) => sense.glosses[0].text)).toEqual(["記錄交易的帳簿。", "分類帳的一頁。"]);
  expect(authored.senses.every((sense) => sense.provenance === "generated")).toBe(true);
  expect(authored.senses[0].generation).toMatchObject({ reviewOutcome: "accepted" });
  lookup.close();
});

test("direct import needs the source's own target-language meaning structure", async () => {
  const { result, path } = await built();

  // Japanese WordNet: three mapped records with their own Japanese definition
  // are imported; a record without a definition stays supporting evidence, and
  // unmapped, unvalidated and non-Japanese records never reach the gate.
  expect(result.languages.ja).toEqual({
    eligible: 3, imported: 3, evidenceOnly: 1, unmatched: 0, rejected: 3
  });
  // Taiwan terminology: bare English/Chinese term pairs are domain evidence
  // only; the one row carrying its own Taiwanese meaning text is imported, and
  // a row for a headword this dictionary does not carry matches nothing.
  expect(result.languages["zh-tw"]).toEqual({
    eligible: 2, imported: 1, evidenceOnly: 2, unmatched: 1, rejected: 1
  });

  const db = new Database(path, { readonly: true });
  // 網 is the definition-less Japanese record and 網路 the bare Taiwan term
  // pair. Neither was published, even though both name a headword the
  // dictionary carries and both had a valid connection to it.
  expect(db.query<{ count: number }, [string]>(
    "select count(*) as count from en_glosses where text like ?"
  ).get("%網%")?.count).toBe(0);

  // Every imported non-English meaning keeps exact provenance.
  expect(db.query<{ lang: string; source_name: string; source_version: string; source_ref: string }, []>(`
    select sense.lang, sense.source_name, sense.source_version, sense.source_ref
      from en_senses sense where sense.lang <> 'en' and sense.provenance = 'source'
     order by sense.lang, sense.source_ref
  `).all()).toEqual([
    { lang: "ja", source_name: "japanese-wordnet", source_version: "1.1-fixture", source_ref: "japanese-wordnet:1.1-fixture:01930874-v:走る" },
    { lang: "ja", source_name: "japanese-wordnet", source_version: "1.1-fixture", source_ref: "japanese-wordnet:1.1-fixture:02084071-n:犬" },
    { lang: "ja", source_name: "japanese-wordnet", source_version: "1.1-fixture", source_ref: "japanese-wordnet:1.1-fixture:07935152-n:水" },
    {
      lang: "zh-tw", source_name: "taiwan-terminology", source_version: "2024-03",
      source_ref: "taiwan-terminology:雙語詞彙、學術名詞暨辭書資訊網:2024-03:nict-2026-000900"
    }
  ]);
  // Taiwan attribution keeps agency, dataset and version.
  expect(db.query<{ attribution: string }, []>(
    "select attribution from en_entry_sources where source = 'taiwan-terminology'"
  ).get()?.attribution).toContain("國家教育研究院");
  db.close();
});

test("no English release artifact leaks one explanation language into another", async () => {
  const { artifacts } = await built();
  const released = new Database(artifacts.sqlite, { readonly: true });

  // Over the whole released database: every gloss and example belongs to
  // exactly one meaning, and that meaning declares exactly one language.
  for (const table of ["en_glosses", "en_examples"]) {
    expect(released.query<{ count: number }, []>(`
      select count(*) as count from ${table} child
       where (select count(*) from en_senses sense where sense.id = child.sense_id) <> 1
    `).get()?.count).toBe(0);
  }
  // No meaning identifier is shared by two languages, and every language's
  // positions run 1..n inside each entry.
  expect(released.query<{ count: number }, []>(
    "select count(*) as count from (select id from en_senses group by id having count(distinct lang) > 1)"
  ).get()?.count).toBe(0);
  expect(released.query<{ count: number }, []>(`
    select count(*) as count from (
      select entry_id, lang from en_senses group by entry_id, lang
       having min(position) <> 1 or max(position) <> count(*)
    )
  `).get()?.count).toBe(0);

  const glosses = released.query<{ lang: string; text: string }, []>(
    "select sense.lang as lang, gloss.text as text from en_glosses gloss join en_senses sense on sense.id = gloss.sense_id"
  ).all();
  expect(glosses).not.toHaveLength(0);
  expect(glosses.filter(({ lang, text }) => foreignToLanguage(lang, text))).toEqual([]);

  const examples = released.query<{ lang: string; text: string; translations: string }, []>(`
    select sense.lang as lang, example.text as text, example.translations as translations
      from en_examples example join en_senses sense on sense.id = example.sense_id
  `).all();
  for (const example of examples) {
    // The headword-language sentence stays English; the paired sentence belongs
    // to the one language that owns the meaning.
    expect(foreignToLanguage("en", example.text)).toBe(false);
    const pairs = JSON.parse(example.translations) as Array<{ lang: string; text: string }>;
    expect(pairs.map(({ lang }) => lang)).toEqual(example.lang === "en" ? [] : [example.lang]);
    for (const pair of pairs) expect(foreignToLanguage(pair.lang, pair.text)).toBe(false);
  }
  released.close();

  for (const line of (await Bun.file(artifacts.jsonl).text()).trim().split("\n")) {
    const entry = JSON.parse(line) as {
      languages: Record<string, { meanings: Array<{ id: string; lang: string; glosses: Array<{ text: string }> }> }>;
    };
    const seen = new Set<string>();
    for (const [lang, group] of Object.entries(entry.languages)) {
      for (const meaning of group.meanings) {
        expect(meaning.lang).toBe(lang);
        expect(seen.has(meaning.id)).toBe(false);
        seen.add(meaning.id);
        for (const gloss of meaning.glosses) expect(foreignToLanguage(lang, gloss.text)).toBe(false);
      }
    }
  }

  // Unzip every produced pack: each holds only its own language's definitions,
  // for only the headwords that language explains, in that language's order.
  const definitions = new Map<string, string[]>();
  for (const [lang, path] of Object.entries(artifacts.yomitan)) {
    const index = JSON.parse(await packEntry(path, "index.json"));
    expect(index.description).toContain(lang);
    const terms = JSON.parse(await packEntry(path, "term_bank_1.json")) as unknown[][];
    const texts = terms.flatMap((term) => term[5] as string[]);
    expect(texts.filter((text) => foreignToLanguage(lang, text))).toEqual([]);
    definitions.set(lang, texts);
  }
  expect(Object.keys(artifacts.yomitan).sort()).toEqual(["en", "ja", "zh-tw"]);
  expect(definitions.get("ja")).toEqual([
    "人間に古くから飼われている哺乳類。", "会計の記録をつける帳簿。", "速く移動する。", "無色透明の液体。"
  ]);
  expect(definitions.get("zh-tw")).toEqual([
    "兩個系統交換訊息的共同邊界。", "記錄交易的帳簿。", "分類帳的一頁。"
  ]);
  // Two packs never share a definition, and every pack installs under its own
  // file name alongside the others.
  for (const [lang, texts] of definitions) {
    for (const [otherLang, otherTexts] of definitions) {
      if (lang === otherLang) continue;
      expect(texts.filter((text) => otherTexts.includes(text))).toEqual([]);
    }
  }
  expect(Object.values(artifacts.yomitan).map((path) => path.split("/").at(-1))).toEqual([
    "yori-en-en.zip", "yori-en-ja.zip", "yori-en-zh-tw.zip"
  ]);
});

test("the manifest reports exact coverage and source versions for all three languages", async () => {
  const { artifacts } = await built();
  const manifest = await Bun.file(artifacts.manifest).json();

  // Imported plus accepted authored content, counted exactly and separately
  // for each explanation language.
  expect(manifest.coverage).toEqual({
    en: { entries: 6, meanings: 6, glosses: 6, examples: 1 },
    ja: { entries: 4, meanings: 4, glosses: 4, examples: 1 },
    "zh-tw": { entries: 2, meanings: 3, glosses: 3, examples: 2 }
  });
  expect(manifest.sourcePolicy.languages).toEqual({
    en: "open-english-wordnet then wiktionary",
    ja: "japanese-wordnet through a validated Princeton WordNet/ILI mapping",
    "zh-tw": "Taiwan government terminology inside its stated domain"
  });
  expect(manifest.sources.map((source: { source: string; lang: string; version: string }) =>
    [source.lang, source.source, source.version]
  )).toEqual([
    ["en", "open-english-wordnet", "2025-fixture"],
    ["ja", "japanese-wordnet", "1.1-fixture"],
    ["ja", "japanese-wordnet", "1.1-extra-fixture"],
    ["zh-tw", "taiwan-terminology", "2024-03"],
    ["zh-tw", "taiwan-terminology", "2024-03-extra"]
  ]);
  expect(manifest.sources.every((source: { license: string; attribution: string }) =>
    Boolean(source.license) && Boolean(source.attribution)
  )).toBe(true);
});

test("repeating the multilingual release from the same accepted data is deterministic", async () => {
  const { path } = await built();
  const root = mkdtempSync(join(tmpdir(), "yori-en-multi-repeat-"));
  const first = await buildEnglishRelease(path, { outputDirectory: join(root, "first"), version: "repeat" });
  const second = await buildEnglishRelease(path, { outputDirectory: join(root, "second"), version: "repeat" });

  expect(await Bun.file(second.jsonl).text()).toEqual(await Bun.file(first.jsonl).text());
  expect(await Bun.file(second.manifest).text()).toEqual(await Bun.file(first.manifest).text());
  expect(Object.keys(second.yomitan)).toEqual(["en", "ja", "zh-tw"]);
  for (const lang of Object.keys(first.yomitan)) {
    expect(await Bun.file(second.yomitan[lang]).bytes()).toEqual(await Bun.file(first.yomitan[lang]).bytes());
  }
});

test("public lookup of a missing language group makes zero model calls", async () => {
  const { path, gateway, close } = await enrichable([]);
  const lookup = openEnglishLookupDb(path);
  try {
    // Public lookup only reads published data. A missing language group is a
    // null, not a reason to author one.
    expect(lookup.lookup("ledger", "ja")).toBeNull();
    expect(lookup.lookup("ledger", "zh-tw")).toBeNull();
    expect(lookup.lookup("ledger", "en")).not.toBeNull();
    expect(lookup.lookup("dog", "ja")).not.toBeNull();
    expect(gateway.calls).toEqual([]);
  } finally {
    lookup.close();
    close();
  }
});

test("missing ja and zh-tw groups are independent concurrent candidates and one rejection isolates the other", async () => {
  const taiwaneseExamples = [
    JSON.stringify({ sentence: "She checked the ledger before closing the accounts.", translation: "她在結帳前查看了帳簿。" }),
    JSON.stringify({ sentence: "The second ledger page was missing.", translation: "第二頁分類帳不見了。" })
  ];
  const { repository, gateway, dictionary, close } = await enrichable((request, lang) => {
    if (request.role === "entry-author") {
      return lang === "ja"
        ? languageGroup([{ definition: "会計の記録をつける帳簿。", partOfSpeech: "noun" }])
        : languageGroup([
            { definition: "記錄交易的帳簿。", partOfSpeech: "noun" },
            { definition: "分類帳的一頁。", partOfSpeech: "noun" }
          ]);
    }
    if (request.role === "entry-review") return lang === "ja" ? "REJECT" : "ACCEPT";
    if (request.role === "example-author") return taiwaneseExamples.shift()!;
    return "ACCEPT";
  });

  try {
    const [japanese, taiwanese] = await Promise.all([
      dictionary.resolve({ query: "ledger", targetDictionary: "en", lang: "ja" }),
      dictionary.resolve({ query: "ledger", targetDictionary: "en", lang: "zh-tw" })
    ]);

    // A rejected group publishes nothing and leaves the sibling untouched.
    expect(japanese).toBeNull();
    expect(repository.find("ledger", "ja")).toBeNull();
    expect(taiwanese?.senses).toHaveLength(2);
    expect(repository.find("ledger", "zh-tw")?.senses.map((sense) => sense.glosses[0].text))
      .toEqual(["記錄交易的帳簿。", "分類帳的一頁。"]);
    // The English group the entry already had is untouched by either request.
    expect(repository.find("ledger", "en")?.senses.map((sense) => sense.glosses[0].text))
      .toEqual(["a book of accounts"]);

    // Separate author and reviewer requests, separate retries and separate
    // terminal outcomes; the two languages never share a model request.
    const candidates = gateway.calls.map((call) => call.prompt.match(/candidateId: (\S+)/)?.[1] ?? "");
    expect(new Set(candidates).size).toBeGreaterThan(1);
    expect(candidates.filter((id) => id.endsWith(":ja"))).toHaveLength(2);
    expect(candidates.filter((id) => id.endsWith(":zh-tw"))).toHaveLength(2);

    // The Taiwanese group divides meanings differently from English, with its
    // own identifiers and its own bilingual examples.
    const zhTw = repository.find("ledger", "zh-tw")!;
    const english = repository.find("ledger", "en")!;
    expect(zhTw.senses.map(({ id }) => id)).not.toContain(english.senses[0].id);
    expect(zhTw.senses[0].examples).toEqual([{
      text: "She checked the ledger before closing the accounts.",
      translations: [{ lang: "zh-tw", text: "她在結帳前查看了帳簿。" }],
      source: "generated",
      reviewStatus: "checked"
    }]);

    // The enriched response carries the entry's own facts, exactly as a later
    // read does. The author writes meanings; pronunciations belong to the entry.
    expect(taiwanese?.id).toBe(english.id);
    expect(taiwanese?.pronunciations).toEqual(english.pronunciations);
    expect(taiwanese?.sources).toEqual(english.sources);
  } finally {
    close();
  }
});

test("a language group must be written in its own language and may not copy the English group", async () => {
  const rejected: Array<[string, unknown]> = [
    // English wording published as Japanese.
    ["ja", languageGroup([{ definition: "a book of accounts", partOfSpeech: "noun" }])],
    // Japanese kana inside a Taiwanese group.
    ["zh-tw", languageGroup([{ definition: "帳簿のこと。", partOfSpeech: "noun" }])],
    // Mainland terminology is not Taiwanese localization.
    ["zh-tw", languageGroup([{ definition: "記錄交易的信息與數據庫。", partOfSpeech: "noun" }])],
    // A group derived from the English meaning list rather than written.
    ["ja", languageGroup([{ definition: "会計の記録。", partOfSpeech: "noun", provenance: "source", evidenceIds: ["open-english-wordnet:ledger%1:10:00::"] }])]
  ];

  for (const [lang, candidate] of rejected) {
    const { repository, gateway, dictionary, close } = await enrichable([candidate as string]);
    try {
      expect(await dictionary.resolve({ query: "ledger", targetDictionary: "en", lang: lang as "ja" })).toBeNull();
      // Rejected before review: no reviewer call, nothing persisted.
      expect(gateway.calls.map(({ role }) => role)).toEqual(["entry-author"]);
      expect(repository.find("ledger", lang as "ja")).toBeNull();
    } finally {
      close();
    }
  }
});

test("the English author schema closes the labels and the language group's provenance", async () => {
  const { gateway, dictionary, close } = await enrichable([
    languageGroup([{ definition: "会計の記録。", partOfSpeech: "noun" }]) as string,
    "ACCEPT"
  ]);

  try {
    await dictionary.resolve({ query: "ledger", targetDictionary: "en", lang: "ja" });
    const author = gateway.calls.find((call) => call.role === "entry-author");
    const sense = (author?.responseSchema?.schema as any).properties.senses.items.properties;
    // A Japanese group is written in Japanese, so without a closed set the
    // author renders the label as 名詞 and the parser refuses it — the same
    // failure the Japanese author had.
    expect(sense.partOfSpeech.enum).toContain("noun");
    expect(sense.partOfSpeech.enum).not.toContain("名詞");
    // `source` is the one value parseEnglishLanguageGroup always refuses, so
    // the schema does not offer it.
    expect(sense.provenance.enum).toEqual(["generated"]);
  } finally {
    close();
  }
});

test("correct imported target-language content is never rewritten and only its example is filled", async () => {
  const { repository, gateway, dictionary, close } = await enrichable([
    JSON.stringify({ sentence: "The dog followed her home.", translation: "その犬は彼女について家まで来た。" }),
    "ACCEPT"
  ]);

  try {
    const entry = await dictionary.resolve({ query: "dog", targetDictionary: "en", lang: "ja" });
    // The imported Japanese meaning is untouched; only the missing example was
    // authored, and it is a true bilingual pair.
    expect(entry?.senses.map((sense) => sense.glosses[0].text)).toEqual(["人間に古くから飼われている哺乳類。"]);
    expect(entry?.senses[0].provenance).toBe("source");
    expect(gateway.calls.map(({ role }) => role)).toEqual(["example-author", "example-review"]);
    expect(repository.find("dog", "ja")?.senses[0].examples).toEqual([{
      text: "The dog followed her home.",
      translations: [{ lang: "ja", text: "その犬は彼女について家まで来た。" }],
      source: "generated",
      reviewStatus: "checked"
    }]);
  } finally {
    close();
  }
});

test("a rejected example leaves the meaning visible and permits one fresh later attempt", async () => {
  const { repository, gateway, dictionary, close } = await enrichable([
    JSON.stringify({ sentence: "The dog barked.", translation: "犬が吠えた。" }),
    "REJECT",
    JSON.stringify({ sentence: "A dog slept by the fire.", translation: "犬が暖炉のそばで眠っていた。" }),
    "ACCEPT"
  ]);

  try {
    const first = await dictionary.resolve({ query: "dog", targetDictionary: "en", lang: "ja" });
    expect(first?.senses).toHaveLength(1);
    expect(first?.senses[0].examples).toEqual([]);
    // The accepted meaning survives the rejected example.
    expect(repository.find("dog", "ja")?.senses[0].glosses[0].text).toBe("人間に古くから飼われている哺乳類。");

    const second = await dictionary.resolve({ query: "dog", targetDictionary: "en", lang: "ja" });
    expect(second?.senses[0].examples.map(({ text }) => text)).toEqual(["A dog slept by the fire."]);
    expect(gateway.calls.map(({ role }) => role)).toEqual([
      "example-author", "example-review", "example-author", "example-review"
    ]);
  } finally {
    close();
  }
});

// --- fixtures ---------------------------------------------------------------

let cached: Promise<Built> | null = null;

type Built = { path: string; result: EnglishRebuildResult; artifacts: EnglishReleaseArtifacts };

function built(): Promise<Built> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "yori-en-multi-"));
    return buildDictionary(root, await fixtureInputs(root));
  })();
  return cached;
}

type FixtureInputs = { sources: EnglishSourceInput[]; languageSources: EnglishLanguageSourceInput[] };

async function fixtureInputs(root: string): Promise<FixtureInputs> {
  return { sources: [await fixtureWordNet(root)], languageSources: await fixtureLanguageSources(root) };
}

/**
 * One published dictionary that carries both kinds of language content:
 * directly imported ja and zh-tw meanings, and accepted authored groups with
 * their bilingual examples.
 */
async function buildDictionary(root: string, inputs: FixtureInputs): Promise<Built> {
  const path = join(root, "english.sqlite");
  const result = await rebuildEnglishDictionary({
    ...inputs,
    out: path,
    version: "2026.08.30",
    retainFrom: null
  });
  migrateProductionDatabase(path);

  const repository = openEnglishEnrichmentRepository(path);
  const dictionary = createEnglishOnDemandDictionary({
    repository,
    modelGateway: new ScriptedGateway((request, lang) => {
      if (request.role === "entry-author") {
        return lang === "ja"
          ? languageGroup([{ definition: "会計の記録をつける帳簿。", partOfSpeech: "noun" }])
          : languageGroup([
              { definition: "記錄交易的帳簿。", partOfSpeech: "noun" },
              { definition: "分類帳的一頁。", partOfSpeech: "noun" }
            ]);
      }
      if (request.role !== "example-author") return "ACCEPT";
      return lang === "ja"
        ? JSON.stringify({ sentence: "He closed the ledger for the year.", translation: "彼は年度の帳簿を締めた。" })
        : JSON.stringify({ sentence: "She checked the ledger twice.", translation: "她查看了帳簿兩次。" });
    }),
    models: { author: "test/english-author", reviewer: "test/english-reviewer" }
  });
  for (const lang of ["ja", "zh-tw"] as const) {
    await dictionary.resolve({ query: "ledger", targetDictionary: "en", lang });
  }
  repository.close();

  return { path, result, artifacts: await buildEnglishRelease(path, { outputDirectory: join(root, "release") }) };
}

async function fixtureWordNet(root: string): Promise<EnglishSourceInput> {
  const file = join(root, "wordnet.zip");
  const entry = (id: string, synset: string, pos = "n") => ({ [pos]: { sense: [{ id, synset }] } });
  await Bun.write(file, createStoredZip([
    {
      name: "entries-a.json",
      content: JSON.stringify({
        dog: entry("dog%1:05:00::", "oewn-02084071-n"),
        run: entry("run%2:38:00::", "oewn-01930874-v", "v"),
        water: entry("water%1:27:00::", "oewn-07935152-n"),
        interface: entry("interface%1:06:00::", "oewn-03187595-n"),
        network: entry("network%1:06:00::", "oewn-08434661-n"),
        // ledger carries a pronunciation so that an authored non-English group
        // can be checked to answer with the entry's own facts.
        ledger: {
          n: { sense: [{ id: "ledger%1:10:00::", synset: "oewn-06481320-n" }], pronunciation: [{ value: "/ˈlɛdʒə/" }] }
        }
      })
    },
    {
      name: "noun.fixture.json",
      content: JSON.stringify({
        "oewn-02084071-n": {
          definition: ["a domesticated carnivorous mammal"],
          example: ["The dog barked at the postman."],
          members: ["dog"], partOfSpeech: "n"
        },
        "oewn-01930874-v": { definition: ["to move quickly on foot"], members: ["run"], partOfSpeech: "v" },
        "oewn-07935152-n": { definition: ["a clear colourless liquid"], members: ["water"], partOfSpeech: "n" },
        "oewn-03187595-n": { definition: ["a shared boundary between systems"], members: ["interface"], partOfSpeech: "n" },
        "oewn-08434661-n": { definition: ["a group of connected things"], members: ["network"], partOfSpeech: "n" },
        "oewn-06481320-n": { definition: ["a book of accounts"], members: ["ledger"], partOfSpeech: "n" }
      })
    }
  ]));
  return { source: "open-english-wordnet", version: "2025-fixture", file, sha256: "oewn-multi-fixture" };
}

/**
 * The committed evidence fixtures plus two extra pinned files that cover the
 * cases they deliberately leave out: a mapped Japanese record with no Japanese
 * definition, and a Taiwan row that carries its own Taiwanese meaning text.
 */
async function fixtureLanguageSources(root: string): Promise<EnglishLanguageSourceInput[]> {
  const japaneseRecords = join(root, "japanese-wordnet.jsonl");
  const japaneseMappings = join(root, "japanese-wordnet-ili.jsonl");
  await copyFile("fixtures/english-evidence/japanese-wordnet.jsonl", japaneseRecords);
  await copyFile("fixtures/english-evidence/japanese-wordnet-ili.jsonl", japaneseMappings);

  const bareRecords = join(root, "japanese-wordnet-bare.jsonl");
  const bareMappings = join(root, "japanese-wordnet-bare-ili.jsonl");
  await writeFile(bareRecords, `${JSON.stringify({ synset: "08434661-n", lemma: "網", lang: "jpn" })}\n`);
  await writeFile(bareMappings, `${JSON.stringify({
    synset: "08434661-n", ili: "i70001", pwnSynset: "pwn-08434661-n", validated: true
  })}\n`);

  const taiwanRecords = join(root, "taiwan-terminology.jsonl");
  await copyFile("fixtures/english-evidence/taiwan-terminology.jsonl", taiwanRecords);
  const taiwanDefined = join(root, "taiwan-terminology-defined.jsonl");
  await writeFile(taiwanDefined, [
    JSON.stringify({
      recordId: "nict-2026-000900", agency: "國家教育研究院", dataset: "雙語詞彙、學術名詞暨辭書資訊網",
      domain: "資訊科技", version: "2024-03",
      attribution: "國家教育研究院 雙語詞彙、學術名詞暨辭書資訊網",
      english: "interface", chinese: "介面", definition: "兩個系統交換訊息的共同邊界。"
    }),
    JSON.stringify({
      recordId: "nict-2026-000901", agency: "國家教育研究院", dataset: "雙語詞彙、學術名詞暨辭書資訊網",
      domain: "資訊科技", version: "2024-03",
      attribution: "國家教育研究院 雙語詞彙、學術名詞暨辭書資訊網",
      english: "widget", chinese: "元件", definition: "介面上的小型元件。"
    })
  ].join("\n"));

  const japaneseMeta = {
    lang: "ja", source: "japanese-wordnet", mappingSource: "princeton-wordnet-ili", mappingVersion: "1.5",
    license: "Japanese WordNet licence", attribution: "Japanese WordNet contributors"
  } as const;
  return [
    { ...japaneseMeta, version: "1.1-fixture", file: japaneseRecords, mappings: japaneseMappings },
    { ...japaneseMeta, version: "1.1-extra-fixture", file: bareRecords, mappings: bareMappings },
    {
      lang: "zh-tw", source: "taiwan-terminology", version: "2024-03", file: taiwanDefined,
      license: "Open Government Data License 1.0", attribution: "國家教育研究院"
    },
    {
      lang: "zh-tw", source: "taiwan-terminology", version: "2024-03-extra", file: taiwanRecords,
      license: "Open Government Data License 1.0", attribution: "國家教育研究院"
    }
  ];
}

/** One authored language group in the shape the entry-author schema requires. */
function languageGroup(
  senses: Array<{ definition: string; partOfSpeech: string; provenance?: string; evidenceIds?: string[] }>
): string {
  return JSON.stringify({
    headword: "ledger",
    pronunciations: [],
    senses: senses.map((sense) => ({
      partOfSpeech: sense.partOfSpeech,
      definition: sense.definition,
      registers: [], regions: [], domains: [], dated: false, usage: [],
      evidenceIds: sense.evidenceIds ?? [],
      provenance: sense.provenance ?? "generated"
    }))
  });
}

async function enrichable(responses: string[] | Responder) {
  const root = mkdtempSync(join(tmpdir(), "yori-en-enrich-"));
  const path = join(root, "english.sqlite");
  await rebuildEnglishDictionary({ ...(await fixtureInputs(root)), out: path, version: "test", retainFrom: null });
  migrateProductionDatabase(path);

  const repository = openEnglishEnrichmentRepository(path);
  const gateway = new ScriptedGateway(responses);
  const dictionary = createEnglishOnDemandDictionary({
    repository,
    modelGateway: gateway,
    models: { author: "test/english-author", reviewer: "test/english-reviewer" }
  });
  return { path, repository, gateway, dictionary, close: () => repository.close() };
}

type Responder = (request: ModelRequest, lang: string) => string;

/** The explanation language a request is about, read from the prompt itself. */
function promptLanguage(prompt: string): string {
  return prompt.match(/explanation_language: (\S+)/)?.[1]
    ?? prompt.match(/"explanationLanguage":"([^"]+)"/)?.[1]
    ?? "en";
}

/**
 * Serves scripted responses. A responder function is used where two languages
 * are resolved concurrently, because their calls interleave.
 */
class ScriptedGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly responses: string[] | Responder) {}

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const text = typeof this.responses === "function"
      ? this.responses(request, promptLanguage(request.prompt))
      : this.responses.shift();
    if (text === undefined) throw new Error(`Unexpected ${request.role} call`);
    return {
      text,
      requestId: `request-${this.calls.length}`,
      model: request.model,
      provider: request.provider,
      effectiveServiceTier: request.requestedServiceTier,
      inputTokens: 10,
      outputTokens: 10
    };
  }
}

/** Reads one file out of a produced Yomitan pack. */
async function packEntry(path: string, name: string): Promise<string> {
  return (await openZipFile(path)).text(name);
}
