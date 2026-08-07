import { resolve } from "node:path";
import { buildJapaneseRelease } from "../src/japanese-release";

const args = Bun.argv.slice(2);
const artifacts = await buildJapaneseRelease(
  resolve(readFlag(args, "--db") ?? process.env.YORI_DB_PATH ?? "data/yori.sqlite"),
  {
    outputDirectory: resolve(readFlag(args, "--out-dir") ?? "releases"),
    ...(readFlag(args, "--version") ? { version: readFlag(args, "--version")! } : {})
  }
);

for (const path of Object.values(artifacts)) console.log(`Wrote ${path}`);

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}
