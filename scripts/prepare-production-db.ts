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
const englishVersion = process.env.YORI_ENGLISH_DICTIONARY_VERSION ?? "2026.08.1";
const configuredEnglishRelease = process.env.YORI_ENGLISH_BOOTSTRAP_PATH;
const localEnglishRelease = resolve(`releases/english/yori-english-${englishVersion}.sqlite`);

const installedJapanese = await ensureJapaneseProductionDatabase(path);
migrateProductionDatabase(path);

let installedEnglish = false;
if (!hasEnglishDictionary(path)) {
  const availableRelease = configuredEnglishRelease
    ? resolve(configuredEnglishRelease)
    : existsSync(localEnglishRelease) ? localEnglishRelease : null;
  if (availableRelease) {
    installedEnglish = importEnglishRelease(path, availableRelease);
  } else {
    const outputDirectory = await mkdtemp(join(tmpdir(), "yori-english-bootstrap-"));
    try {
      const process = Bun.spawn([
        "bun", "run", "scripts/build-english-dictionary.ts",
        "--version", englishVersion,
        "--out-dir", outputDirectory
      ], { stdout: "inherit", stderr: "inherit" });
      const exitCode = await process.exited;
      if (exitCode !== 0) throw new Error(`English bootstrap build failed with exit code ${exitCode}`);
      installedEnglish = importEnglishRelease(
        path,
        join(outputDirectory, `yori-english-${englishVersion}.sqlite`)
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

const legacy = importLegacyOverlays(
  path,
  resolve(process.env.YORI_LEGACY_JA_OVERLAY_PATH ?? join(dirname(path), "example-overlay.sqlite")),
  resolve(process.env.YORI_LEGACY_ENGLISH_OVERLAY_PATH ?? join(dirname(path), "english-overlay.sqlite"))
);

console.log(JSON.stringify({
  event: "production_database_ready",
  path,
  installedJapanese,
  installedEnglish,
  importedLegacyJapanese: legacy.japanese,
  importedLegacyEnglish: legacy.english
}));
