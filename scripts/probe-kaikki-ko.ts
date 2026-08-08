import { Database } from "bun:sqlite";
import { dirname } from "node:path";

type Args = {
  dbPath: string;
  inputPath: string | null;
  outPath: string;
  limit: number;
  maxGlosses: number;
  includeShort: boolean;
  commonOnly: boolean;
};

type KaikkiEntry = {
  word?: unknown;
  lang_code?: unknown;
  pos?: unknown;
  translations?: unknown;
};

type KaikkiTranslation = {
  lang_code?: unknown;
  word?: unknown;
  sense?: unknown;
};

type MatchedSense = {
  entry_id: string;
  sense_id: string;
  source_id: string;
  common: 0 | 1;
};

type CandidateRow = {
  entryId: string;
  senseId: string;
  lang: "ko";
  glosses: string[];
  source: "wiktionary-kaikki";
  sourceWord: string;
  sourcePos: string;
  common: boolean;
};

const defaultKaikkiJaUrl = "https://kaikki.org/dictionary/downloads/ja/ja-extract.jsonl.gz";
const allowedPos = new Set(["noun", "verb", "adj", "adv", "adj_noun", "pron"]);

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  await run(args);
}

export async function run(args: Args): Promise<void> {
  await Bun.$`mkdir -p ${dirname(args.outPath)}`;

  const db = new Database(args.dbPath, { readonly: true });
  const rows: CandidateRow[] = [];
  const seenSenses = new Set<string>();
  const stats = {
    entries: 0,
    jaEntries: 0,
    withKoTranslations: 0,
    skippedPos: 0,
    skippedShort: 0,
    skippedMixedTranslationSenses: 0,
    skippedNoMatch: 0,
    skippedAmbiguous: 0,
    skippedExistingKo: 0,
    skippedDuplicateSense: 0,
    skippedUncommon: 0,
    matched: 0
  };

  for (const line of (await readKaikkiJsonl(args)).split("\n")) {
    if (rows.length >= args.limit) break;
    if (!line.trim()) continue;

    stats.entries += 1;
    const entry = JSON.parse(line) as KaikkiEntry;
    if (entry.lang_code !== "ja" || typeof entry.word !== "string") continue;
    stats.jaEntries += 1;

    const pos = typeof entry.pos === "string" ? entry.pos : "";
    if (!allowedPos.has(pos)) {
      stats.skippedPos += 1;
      continue;
    }
    if (!args.includeShort && isShortAmbiguousJapaneseWord(entry.word)) {
      stats.skippedShort += 1;
      continue;
    }

    const glosses = koreanGlosses(entry.translations);
    if (glosses === "mixed-senses") {
      stats.skippedMixedTranslationSenses += 1;
      continue;
    }
    if (glosses.length === 0) continue;
    stats.withKoTranslations += 1;

    const match = findSingleSenseMatch(db, entry.word);
    if (match === "no-match") {
      stats.skippedNoMatch += 1;
      continue;
    }
    if (match === "ambiguous") {
      stats.skippedAmbiguous += 1;
      continue;
    }
    if (args.commonOnly && match.common !== 1) {
      stats.skippedUncommon += 1;
      continue;
    }
    if (hasExistingKoGlosses(db, match.sense_id)) {
      stats.skippedExistingKo += 1;
      continue;
    }
    if (seenSenses.has(match.sense_id)) {
      stats.skippedDuplicateSense += 1;
      continue;
    }

    seenSenses.add(match.sense_id);
    rows.push({
      entryId: match.entry_id,
      senseId: match.sense_id,
      lang: "ko",
      glosses: glosses.slice(0, args.maxGlosses),
      source: "wiktionary-kaikki",
      sourceWord: entry.word,
      sourcePos: pos,
      common: match.common === 1
    });
    stats.matched += 1;
  }

  db.close();

  await Bun.write(args.outPath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));

  console.log(`Wrote ${rows.length} Kaikki KO candidate row(s) to ${args.outPath}`);
  console.log(JSON.stringify(stats, null, 2));
}

function parseArgs(argv: string[]): Args {
  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    inputPath: readFlag(argv, "--input"),
    outPath: readFlag(argv, "--out") ?? "data/kaikki/ko-candidates.jsonl",
    limit: parsePositiveInt(readFlag(argv, "--limit") ?? "100", "--limit"),
    maxGlosses: parsePositiveInt(readFlag(argv, "--max-glosses") ?? "6", "--max-glosses"),
    includeShort: argv.includes("--include-short"),
    commonOnly: argv.includes("--common-only")
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function readKaikkiJsonl(args: Args): Promise<string> {
  if (!args.inputPath) {
    const response = await fetch(defaultKaikkiJaUrl);
    if (!response.ok) {
      throw new Error(`Kaikki download failed: ${response.status} ${response.statusText}`);
    }
    return gunzipText(await response.arrayBuffer());
  }

  const bytes = await Bun.file(args.inputPath).arrayBuffer();
  if (args.inputPath.endsWith(".gz")) {
    return gunzipText(bytes);
  }
  return new TextDecoder().decode(bytes);
}

function gunzipText(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(Bun.gunzipSync(bytes));
}

function koreanGlosses(value: unknown): string[] | "mixed-senses" {
  if (!Array.isArray(value)) return [];

  const bySense = new Map<string, string[]>();

  for (const item of value as KaikkiTranslation[]) {
    if (item.lang_code !== "ko" || typeof item.word !== "string") continue;

    const gloss = cleanKoreanGloss(item.word);
    if (!gloss) continue;

    const sense = typeof item.sense === "string" && item.sense.trim() ? item.sense.trim() : "__no_sense__";
    const glosses = bySense.get(sense) ?? [];
    if (!glosses.includes(gloss)) glosses.push(gloss);
    bySense.set(sense, glosses);
  }

  const nonEmptyGroups = Array.from(bySense.values()).filter((glosses) => glosses.length > 0);
  if (nonEmptyGroups.length > 1) return "mixed-senses";
  return nonEmptyGroups[0] ?? [];
}

function cleanKoreanGloss(value: string): string | null {
  const gloss = value
    .trim()
    .replace(/\([一-龯々〆ヵヶ]+\)/g, "")
    .replace(/（[一-龯々〆ヵヶ]+）/g, "")
    .replace(/\s+/g, " ");

  if (!/\p{Script=Hangul}/u.test(gloss)) return null;
  if (/[;；/／\n]/.test(gloss)) return null;
  if (gloss.length > 24) return null;

  return gloss;
}

function isShortAmbiguousJapaneseWord(word: string): boolean {
  const chars = Array.from(word);
  if (chars.length <= 1) return true;
  return chars.length <= 2 && /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(word);
}

function findSingleSenseMatch(db: Database, word: string): MatchedSense | "no-match" | "ambiguous" {
  const rows = db
    .query<MatchedSense & { sense_count: number }, [string]>(
      `select
         e.id as entry_id,
         min(s.id) as sense_id,
         e.source_id,
         max(f.common) as common,
         count(distinct s.id) as sense_count
       from ja_lookup_terms lt
       join ja_entries e on e.id = lt.entry_id
       join ja_forms f on f.entry_id = e.id and f.text = lt.term
       join ja_senses s on s.entry_id = e.id and s.lang = 'en'
       where lt.term = ?
       group by e.id, e.source_id`
    )
    .all(word);

  if (rows.length === 0) return "no-match";
  const singleSenseRows = rows.filter((row) => row.sense_count === 1);
  if (singleSenseRows.length !== 1) return "ambiguous";

  const row = singleSenseRows[0];
  return {
    entry_id: row.entry_id,
    sense_id: row.sense_id.replace(/:en$/, ""),
    source_id: row.source_id,
    common: row.common
  };
}

function hasExistingKoGlosses(db: Database, senseId: string): boolean {
  const row = db
    .query<{ count: number }, [string]>(
      "select count(*) as count from ja_senses where id = ? and lang = 'ko'"
    )
    .get(`${senseId}:ko`);
  return (row?.count ?? 0) > 0;
}
