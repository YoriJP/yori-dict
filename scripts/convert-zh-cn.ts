import { dirname } from "node:path";
import { Converter } from "opencc-js";
import { formatJsonl, normalizeGlosses, type AiGlossSource } from "./ai-gloss-validation";
import { readJsonl } from "./ai-common";

type Args = {
  inputPath: string;
  outPath: string;
  model: string;
};

const args = parseArgs(Bun.argv.slice(2));
const rows = await readJsonl<AiGlossSource>(args.inputPath);
const convert = Converter({ from: "twp", to: "cn" });

const converted = rows.map((row) => ({
  senseId: row.senseId,
  lang: "zh-cn" as const,
  glosses: uniqueGlosses(normalizeGlosses(row.glosses).map((gloss) => convert(gloss))),
  source: "ai-assisted" as const,
  model: args.model
}));

await Bun.$`mkdir -p ${dirname(args.outPath)}`;
await Bun.write(args.outPath, formatJsonl(converted));

console.log(`Converted ${converted.length} zh-TW row(s) to ${args.outPath}`);

function parseArgs(argv: string[]): Args {
  return {
    inputPath: readFlag(argv, "--input") ?? "sources/ai-glosses/zh-tw.jsonl",
    outPath: readFlag(argv, "--out") ?? "sources/ai-glosses/zh-cn.jsonl",
    model: readFlag(argv, "--model") ?? "opencc-js-1.3.1:twp-cn"
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function uniqueGlosses(glosses: string[]): string[] {
  return Array.from(new Set(glosses));
}
