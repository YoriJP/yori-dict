import { resolve } from "node:path";
import { buildEnglishReleaseFromProduction } from "../src/english-release";

const version = flag("--version");
if (!version) throw new Error("--version is required so English releases remain independent and explicit");

const artifacts = await buildEnglishReleaseFromProduction(
  resolve(flag("--db") ?? process.env.YORI_DB_PATH ?? "data/yori.sqlite"),
  {
    outputDirectory: resolve(flag("--out-dir") ?? "releases/english"),
    version,
    ...(flag("--created-at") ? { createdAt: flag("--created-at")! } : {})
  }
);
console.log(JSON.stringify({ artifacts }, null, 2));

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}
