import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { publishDraftRelease, type ReleaseDictionary } from "../src/release-publish";

const dictionary = flag("--dictionary");
const version = flag("--version");
if ((dictionary !== "en" && dictionary !== "ja") || !version) {
  throw new Error("Usage: bun run release:publish -- --dictionary en|ja --version <version> [--allow-fewer-entries]");
}
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("Set GITHUB_TOKEN to a token that can write releases");
// Railway sets this to the deployed commit, which is the code that built the data.
const target = flag("--target") ?? process.env.RAILWAY_GIT_COMMIT_SHA;
if (!target) throw new Error("Pass --target <commit> outside Railway");

const databasePath = resolve(process.env.YORI_DB_PATH ?? "data/yori.sqlite");
const draft = await publishDraftRelease({
  dictionary: dictionary as ReleaseDictionary,
  version,
  databasePath,
  // Not beside the database: the export copies the whole database before
  // dropping other tables, and the volume has no room for that copy.
  workDirectory: resolve(flag("--work-dir") ?? tmpdir()),
  repository: "YoriJP/yori-dict",
  token,
  target,
  allowFewerEntries: Bun.argv.includes("--allow-fewer-entries")
});
console.log(`Draft ${draft.tag}: ${draft.url}`);

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}
