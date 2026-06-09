import { expect, test } from "bun:test";

test("exports conservative Kaikki Korean candidates", async () => {
  const dbPath = tempPath("kaikki-ko.sqlite");
  const inputPath = tempPath("kaikki-ko.jsonl");
  const outPath = tempPath("kaikki-ko-candidates.jsonl");
  await Bun.$`rm -f ${dbPath} ${inputPath} ${outPath}`;
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${dbPath}`;

  await Bun.write(
    inputPath,
    [
      {
        word: "学校",
        lang_code: "ja",
        pos: "noun",
        translations: [
          { lang_code: "ko", word: "학교(學校)" },
          { lang_code: "ko", word: "학교" },
          { lang_code: "en", word: "school" }
        ]
      },
      {
        word: "遇う",
        lang_code: "ja",
        pos: "verb",
        translations: [{ lang_code: "ko", word: "대하다" }]
      },
      {
        word: "食べる",
        lang_code: "ja",
        pos: "particle",
        translations: [{ lang_code: "ko", word: "먹다" }]
      }
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );

  await Bun.$`bun run scripts/probe-kaikki-ko.ts --db ${dbPath} --input ${inputPath} --out ${outPath} --limit 10`;

  expect(await readJsonl(outPath)).toEqual([
    {
      entryId: "yori:e_jmdict_1206730",
      senseId: "yori:s_jmdict_1206730_1",
      lang: "ko",
      glosses: ["학교"],
      source: "wiktionary-kaikki",
      sourceWord: "学校",
      sourcePos: "noun",
      common: true
    }
  ]);
});

async function readJsonl(path: string): Promise<unknown[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function tempPath(name: string): string {
  return `/tmp/yori-dict-api-${process.pid}-${name}`;
}
