import { resolve } from "node:path";
import { buildEnglishRelease } from "../src/english-release";

const artifacts = await buildEnglishRelease(
  resolve(flag("--db") ?? process.env.YORI_DB_PATH ?? "data/yori.sqlite"),
  {
    outputDirectory: resolve(flag("--out-dir") ?? "releases/english"),
    ...(flag("--version") ? { version: flag("--version")! } : {})
  }
);

for (const artifact of Object.values(artifacts)) {
  for (const path of typeof artifact === "string" ? [artifact] : Object.values(artifact)) {
    console.log(`Wrote ${path}`);
  }
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}
