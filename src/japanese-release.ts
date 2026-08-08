import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Database } from "bun:sqlite";
import { createLanguageBanks, writeYomitanPacks } from "./yomitan-pack";
import {
  fileSha256,
  readCoverageFrom,
  snapshotCanonicalDatabase
} from "./canonical-store";
import { visitJapaneseEntries, type JapaneseEntryGroups } from "./db";
import {
  japaneseCanonicalTables,
  japaneseSchemaVersion,
  readCoverage,
  type LanguageCoverage
} from "./japanese-schema";
import type { ApiLang, PublicSense } from "./types";

export type JapaneseReleaseArtifacts = {
  sqlite: string;
  gzip: string;
  checksum: string;
  jsonl: string;
  manifest: string;
  /** One Yomitan pack per explanation language, keyed by that language. */
  yomitan: Record<string, string>;
};

const yomitanTitles: Record<string, string> = {
  en: "Yori Japanese–English",
  de: "Yori Japanisch–Deutsch",
  "zh-tw": "Yori 日中辭典（台灣正體）",
  "zh-cn": "Yori 日中词典（简体）",
  ko: "Yori 일본어–한국어",
  ja: "Yori 日本語辞典"
};

export async function buildJapaneseRelease(
  productionPath: string,
  options: { outputDirectory: string; version?: string }
): Promise<JapaneseReleaseArtifacts> {
  const production = Bun.file(productionPath);
  if (!(await production.exists())) throw new Error(`Production database does not exist: ${productionPath}`);
  await mkdir(options.outputDirectory, { recursive: true });

  const metadata = readMetadata(productionPath);
  const version = options.version ?? metadata.dictionaryVersion ?? "unknown";
  const base = `yori-dict-${version}`;
  const artifacts: JapaneseReleaseArtifacts = {
    sqlite: join(options.outputDirectory, `${base}.sqlite`),
    gzip: join(options.outputDirectory, `${base}.sqlite.gz`),
    checksum: join(options.outputDirectory, `${base}.sqlite.gz.sha256`),
    jsonl: join(options.outputDirectory, `${base}.jsonl`),
    manifest: join(options.outputDirectory, `${base}.json`),
    yomitan: {}
  };
  await Promise.all([
    artifacts.sqlite, artifacts.gzip, artifacts.checksum, artifacts.jsonl, artifacts.manifest
  ].map((path) => rm(path, { force: true })));

  snapshotCanonicalDatabase(productionPath, artifacts.sqlite, japaneseCanonicalTables);
  const coverage = readCoverageFrom(artifacts.sqlite, "ja");
  for (const lang of Object.keys(coverage)) {
    artifacts.yomitan[lang] = join(options.outputDirectory, `yori-ja-${lang}.zip`);
    await rm(artifacts.yomitan[lang], { force: true });
  }

  const banks = createLanguageBanks(Object.keys(coverage));
  const writer = Bun.file(artifacts.jsonl).writer();
  let entries = 0;

  visitJapaneseEntries(artifacts.sqlite, (record) => {
    writer.write(`${JSON.stringify(canonicalRecord(record))}\n`);
    entries += 1;
    for (const group of record.groups) {
      banks.add(group.lang, (sequence) => [
        record.entry.word,
        record.entry.reading ?? "",
        "",
        "",
        0,
        // Meanings keep this language's own stored order.
        group.senses.flatMap((sense) => sense.glosses.map((gloss) => gloss.text)),
        sequence,
        ""
      ]);
    }
  });
  await writer.end();

  await writeYomitanPacks(banks, {
    revision: version,
    path: (lang) => artifacts.yomitan[lang]!,
    index: (lang) => ({
      title: yomitanTitles[lang] ?? `Yori Japanese (${lang})`,
      attribution: "JMdict and Yori Dict contributors; see the release manifest.",
      // Named explanation language of this pack; it contains no other.
      description: `Japanese headwords explained in ${lang}.`
    })
  });

  await pipeline(createReadStream(artifacts.sqlite), createGzip({ level: 9 }), createWriteStream(artifacts.gzip));
  const sha256 = await fileSha256(artifacts.gzip);
  await writeFile(artifacts.checksum, `${sha256}  ${basename(artifacts.gzip)}\n`);
  const sqliteStats = await stat(artifacts.sqlite);
  const gzipStats = await stat(artifacts.gzip);
  await writeFile(artifacts.manifest, `${JSON.stringify({
    artifact: basename(artifacts.gzip),
    checksum: basename(artifacts.checksum),
    jsonl: basename(artifacts.jsonl),
    yomitan: Object.fromEntries(
      Object.entries(artifacts.yomitan).map(([lang, path]) => [lang, basename(path)])
    ),
    sha256,
    sqliteBytes: sqliteStats.size,
    gzipBytes: gzipStats.size,
    artifactVersion: version,
    schemaVersion: japaneseSchemaVersion,
    dictionaryVersion: metadata.dictionaryVersion,
    jmdictSimplifiedVersion: metadata.jmdictSimplifiedVersion,
    entries,
    coverage,
    sources: japaneseSources(metadata)
  }, null, 2)}\n`);
  return artifacts;
}

/**
 * One canonical record per entry: shared identity and written forms, then one
 * sibling group per explanation language with that language's own ordered
 * meanings, glosses, examples, and concise source identifiers.
 */
function canonicalRecord(record: JapaneseEntryGroups) {
  return {
    ...record.entry,
    languages: Object.fromEntries(record.groups.map((group) => [
      group.lang,
      { meanings: group.senses.map((sense) => releaseMeaning(sense, group.lang)) }
    ]))
  };
}

function releaseMeaning(sense: PublicSense, lang: ApiLang) {
  const { glosses, examples, evidenceIds, provenance, ...rest } = sense;
  return {
    ...rest,
    lang,
    provenance: provenance ?? "source",
    sources: evidenceIds ?? [],
    glosses: glosses.map(({ lang: _lang, ...gloss }) => gloss),
    examples: examples ?? []
  };
}



function readMetadata(path: string) {
  const db = new Database(path, { readonly: true });
  const value = (key: string) => db.query<{ value: string }, [string]>(
    "select value from ja_metadata where key = ?"
  ).get(key)?.value ?? null;
  try {
    return {
      dictionaryVersion: value("dictDate"),
      jmdictSimplifiedVersion: value("jmdictSimplifiedVersion")
    };
  } finally {
    db.close();
  }
}


/**
 * Every source records the version the release was actually built from. A
 * version the rebuild does not pin is omitted rather than described in prose,
 * so a reader never mistakes a placeholder for recorded provenance.
 */
function japaneseSources(metadata: { jmdictSimplifiedVersion: string | null; dictionaryVersion: string | null }) {
  return [
    {
      name: "JMdict",
      ...(metadata.jmdictSimplifiedVersion ? { version: metadata.jmdictSimplifiedVersion } : {}),
      ...(metadata.dictionaryVersion ? { dictDate: metadata.dictionaryVersion } : {}),
      license: "CC-BY-SA-4.0",
      url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
    },
    { name: "Tatoeba example sentences", license: "CC-BY-2.0-FR", url: "https://tatoeba.org/en/terms_of_use" },
    { name: "yomitan-jlpt-vocab", license: "CC-BY-SA-4.0", url: "https://github.com/stephenmk/yomitan-jlpt-vocab" },
    { name: "Yori generated dictionary content", license: "CC-BY-SA-4.0" }
  ];
}
