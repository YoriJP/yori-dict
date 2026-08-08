import { rebuildJapaneseDictionary } from "../src/japanese-rebuild";

const argv = Bun.argv.slice(2);
const input = readFlag(argv, "--input");
const out = readFlag(argv, "--out");
if (!input || !out) {
  console.error(
    "Usage: bun run scripts/import-jmdict.ts --input path/to/jmdict.json --out data/yori.sqlite" +
      " [--examples path/to/jmdict-examples.json] [--jlpt-vocab path/to/jlpt-csv-directory]" +
      " [--ai-glosses path/to/glosses.jsonl]... [--ai-examples path/to/examples.jsonl]..." +
      " [--retain-from path/to/previous.sqlite | --no-retain]"
  );
  process.exit(1);
}

const result = await rebuildJapaneseDictionary({
  input,
  out,
  examples: readFlag(argv, "--examples"),
  jlptVocab: readFlag(argv, "--jlpt-vocab"),
  aiGlosses: readFlags(argv, "--ai-glosses"),
  aiExamples: readFlags(argv, "--ai-examples"),
  retainFrom: argv.includes("--no-retain") ? null : readFlag(argv, "--retain-from") ?? undefined
});

console.log(JSON.stringify({
  event: "japanese_rebuild_complete",
  path: result.path,
  entries: result.entries,
  coverage: result.coverage,
  sourcedExamples: result.sourcedExamples,
  legacyGlosses: result.legacyGlosses,
  legacyExamples: result.legacyExamples,
  retained: result.retained
}, null, 2));

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function readFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}
