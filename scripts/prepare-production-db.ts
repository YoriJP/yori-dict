import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { importLegacyOverlays } from "../src/legacy-overlay-import";
import {
  ensureJapaneseProductionDatabase,
  hasEnglishDictionary,
  importEnglishRelease,
  migrateProductionDatabase
} from "../src/production-database";

const path = resolve(process.env.YORI_DB_PATH ?? "data/yori.sqlite");
// The English source version is pinned here, the way the Japanese release is
// pinned in data-release.json. It was a runtime variable nothing ever set.
const englishVersion = "2026.08.1";
const localEnglishRelease = resolve(`releases/english/yori-english-${englishVersion}.sqlite`);

const installedJapanese = await ensureJapaneseProductionDatabase(path);
migrateProductionDatabase(path);

let installedEnglish = false;
if (!hasEnglishDictionary(path)) {
  const availableRelease = existsSync(localEnglishRelease) ? localEnglishRelease : null;
  if (availableRelease) {
    installedEnglish = importEnglishRelease(path, availableRelease);
  } else {
    const outputDirectory = await mkdtemp(join(tmpdir(), "yori-english-bootstrap-"));
    try {
      const rebuilt = join(outputDirectory, `yori-english-${englishVersion}.sqlite`);
      const process = Bun.spawn([
        "bun", "run", "scripts/build-english-dictionary.ts",
        "--version", englishVersion,
        "--out", rebuilt
      ], { stdout: "inherit", stderr: "inherit" });
      const exitCode = await process.exited;
      if (exitCode !== 0) throw new Error(`English bootstrap build failed with exit code ${exitCode}`);
      installedEnglish = importEnglishRelease(path, rebuilt);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

// Overlays are a one-time rescue of enrichment written before ADR-0009 merged
// the stores. Nothing produces them now, and the import is a no-op when the
// files are absent, so they sit at fixed names beside the database.
const legacy = importLegacyOverlays(
  path,
  resolve(join(dirname(path), "example-overlay.sqlite")),
  resolve(join(dirname(path), "english-overlay.sqlite"))
);

console.log(JSON.stringify({
  event: "production_database_ready",
  path,
  installedJapanese,
  installedEnglish,
  importedLegacyJapanese: legacy.japanese,
  importedLegacyEnglish: legacy.english
}));
