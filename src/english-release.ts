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
import {
  createEnglishDictionaryValidator,
  visitEnglishEntries,
  type EnglishEntryGroups
} from "./english-dictionary";
import {
  englishCanonicalTables,
  englishSchemaVersion,
  readCoverage,
  type LanguageCoverage
} from "./english-schema";
import type { EnglishSense } from "./english-types";

export type EnglishReleaseArtifacts = {
  sqlite: string;
  gzip: string;
  checksum: string;
  jsonl: string;
  manifest: string;
  /** One Yomitan pack per explanation language, keyed by that language. */
  yomitan: Record<string, string>;
};

/** Short pack names, one per language pair, so installed packs stay distinguishable. */
const yomitanTitles: Record<string, string> = {
  en: "Yori English–English",
  ja: "Yori English–Japanese",
  "zh-tw": "Yori English–Chinese (Taiwan)"
};

/**
 * Publishes the English product from the canonical `en_*` tables: a snapshot
 * SQLite, JSONL with one content group per explanation language, a coverage and
 * source manifest, and one deterministic Yomitan pack per language. The Yomitan
 * adapter reads canonical senses in their stored order; it never drives the
 * schema and never flattens two languages into one pack.
 */
export async function buildEnglishRelease(
  productionPath: string,
  options: { outputDirectory: string; version?: string }
): Promise<EnglishReleaseArtifacts> {
  const production = Bun.file(productionPath);
  if (!(await production.exists())) throw new Error(`English database does not exist: ${productionPath}`);
  await mkdir(options.outputDirectory, { recursive: true });

  const metadata = readMetadata(productionPath);
  const version = options.version ?? metadata.dictionaryVersion ?? "unknown";
  const base = `yori-english-${version}`;
  const artifacts: EnglishReleaseArtifacts = {
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

  snapshotCanonicalDatabase(productionPath, artifacts.sqlite, englishCanonicalTables);
  const coverage = readCoverageFrom(artifacts.sqlite, "en");
  for (const lang of Object.keys(coverage)) {
    artifacts.yomitan[lang] = join(options.outputDirectory, `yori-en-${lang}.zip`);
    await rm(artifacts.yomitan[lang], { force: true });
  }

  const banks = createLanguageBanks(Object.keys(coverage));
  const writer = Bun.file(artifacts.jsonl).writer();
  const problems: string[] = [];
  const validator = createEnglishDictionaryValidator();
  let entries = 0;

  visitEnglishEntries(artifacts.sqlite, (record) => {
    problems.push(...validator.check([record]));
    writer.write(`${JSON.stringify(canonicalRecord(record))}\n`);
    entries += 1;
    for (const group of record.groups) {
      // English carries one written form per entry and no common flag, and its
      // parts of speech are WordNet's rather than JMdict's, so neither `rules`
      // nor `score` has a value here that would not be invented. They stay at
      // the schema's "no grammatical category" and "unranked".
      banks.add(group.lang, [(sequence) => [
        record.entry.headword,
        "",
        [...new Set(group.senses.map(({ partOfSpeech }) => partOfSpeech))].join(" "),
        "",
        0,
        // Senses keep this language's own stored order.
        group.senses.flatMap((sense) => sense.glosses.map((gloss) => gloss.text)),
        sequence,
        ""
      ]]);
    }
  });
  await writer.end();
  if (problems.length > 0) throw new Error(`Invalid English dictionary:\n${problems.slice(0, 20).join("\n")}`);

  await writeYomitanPacks(banks, {
    revision: version,
    path: (lang) => artifacts.yomitan[lang]!,
    index: (lang) => ({
      title: yomitanTitles[lang] ?? `Yori English (${lang})`,
      attribution: `${languageAttribution(metadata.sources, lang)}; see the release manifest.`,
      // Named explanation language of this pack; it contains no other.
      description: `English headwords explained in ${lang}.`
    })
  });

  await pipeline(createReadStream(artifacts.sqlite), createGzip({ level: 9 }), createWriteStream(artifacts.gzip));
  const sha256 = await fileSha256(artifacts.gzip);
  await writeFile(artifacts.checksum, `${sha256}  ${basename(artifacts.gzip)}\n`);
  const sqliteStats = await stat(artifacts.sqlite);
  const gzipStats = await stat(artifacts.gzip);
  await writeFile(artifacts.manifest, `${JSON.stringify({
    dictionary: "en",
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
    schemaVersion: englishSchemaVersion,
    dictionaryVersion: metadata.dictionaryVersion,
    sourcePolicy: metadata.sourcePolicy,
    entries,
    coverage,
    sources: metadata.sources
  }, null, 2)}\n`);
  return artifacts;
}

/**
 * One canonical record per entry: shared identity, written form, pronunciations
 * and concise sources, then one sibling group per explanation language with
 * that language's own ordered senses, glosses, examples and provenance.
 */
function canonicalRecord(record: EnglishEntryGroups) {
  return {
    ...record.entry,
    languages: Object.fromEntries(record.groups.map((group) => [
      group.lang,
      { senses: group.senses.map(releaseSense) }
    ]))
  };
}

function releaseSense(sense: EnglishSense) {
  const { evidenceIds, examples, ...rest } = sense;
  return { ...rest, sources: evidenceIds, examples };
}

/**
 * Attribution for one pack: the sources that may publish content in that
 * explanation language, and no others. Generated groups have no source, so a
 * language with none says so rather than borrowing English's attribution.
 */
function languageAttribution(sources: unknown[], lang: string): string {
  const named = sources.flatMap((source) => {
    const record = source as { lang?: unknown; attribution?: unknown };
    return record.lang === lang && typeof record.attribution === "string" ? [record.attribution] : [];
  });
  return named.length > 0 ? named.join("; ") : "Yori Dict authored and reviewed content";
}



function readMetadata(path: string) {
  const db = new Database(path, { readonly: true });
  const value = (key: string) => db.query<{ value: string }, [string]>(
    "select value from en_metadata where key = ?"
  ).get(key)?.value ?? null;
  try {
    const sources = value("sources");
    const policy = value("sourcePolicy");
    return {
      dictionaryVersion: value("dictionaryVersion"),
      sources: sources ? (JSON.parse(sources) as unknown[]) : [],
      sourcePolicy: policy ? (JSON.parse(policy) as unknown) : null
    };
  } finally {
    db.close();
  }
}

