import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openLookupDb } from "./db";
import { openEnrichmentRepository } from "./enrichment-repository";
import { openEnglishEnrichmentRepository } from "./english-enrichment-repository";
import type { AttemptRecord } from "./on-demand-dictionary";
import type { EnglishEntry, EnglishExample } from "./english-types";
import type { ApiLang, PublicExample, PublicLookupItem } from "./types";
import { parseApiLang } from "./lang";

/**
 * A one-time absorption of the pre-canonical overlay databases, run once per
 * marker and only when such a file is actually present beside the production
 * database.
 *
 * The old table names appear only here, and only as things to read out of a
 * separate legacy file. Nothing in lookup, enrichment, rebuild, or release
 * knows them. A legacy record held every gloss language against one shared
 * sense list; it is split into independent language groups on the way in and
 * keeps the provenance it was written with, including the converter that
 * produced the legacy Simplified Chinese rows. There is no second lookup or
 * storage implementation behind this: after absorption the rows are ordinary
 * canonical rows.
 */
export function importLegacyOverlays(
  productionPath: string,
  japaneseOverlayPath: string,
  englishOverlayPath: string
): { japanese: boolean; english: boolean } {
  return {
    japanese: importJapaneseOverlay(productionPath, japaneseOverlayPath),
    english: importEnglishOverlay(productionPath, englishOverlayPath)
  };
}

function importJapaneseOverlay(productionPath: string, overlayPath: string): boolean {
  if (!canImport(productionPath, overlayPath, "legacyJapaneseOverlay")) return false;
  const legacy = new Database(overlayPath, { readonly: true });
  const lookup = openLookupDb(productionPath);
  const repository = openEnrichmentRepository(productionPath, lookup);
  try {
    if (hasTable(legacy, "on_demand_entries")) {
      for (const row of legacy.query<{ entry_json: string }, []>("select entry_json from on_demand_entries order by entry_id").all()) {
        // A legacy record held every gloss language against one sense list.
        // It is split back into one independent group per language, keeping
        // each language's own senses, ids, and order.
        for (const [lang, entry] of splitLegacyEntry(JSON.parse(row.entry_json) as PublicLookupItem)) {
          // A legacy group for a headword the dictionary already carries joins
          // that entry's identity. Minting a second entry for the same written
          // form would leave the absorbed group unreadable.
          const canonical = repository.canonicalEntry?.(entry.word);
          // Content the dictionary already carries in this language is correct
          // and stays untouched; only a missing language group is absorbed.
          if (repository.find(entry.word, "ja", lang)) continue;
          repository.saveEntry(canonical ? { ...entry, id: canonical.id } : entry, lang);
        }
      }
    }
    const production = new Database(productionPath, { readonly: true });
    try {
      const saveLegacyExample = (senseId: string, example: PublicExample) => {
        for (const [targetSenseId, owned] of legacyExampleTargets(production, senseId, example)) {
          repository.saveExample(targetSenseId, owned);
        }
      };
      if (hasTable(legacy, "on_demand_examples")) {
        for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(
          "select sense_id, example_json from on_demand_examples order by sense_id"
        ).all()) saveLegacyExample(row.sense_id, JSON.parse(row.example_json) as PublicExample);
      }
      if (hasTable(legacy, "example_enrichments")) {
        for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(`
          select sense_id, example_json from example_enrichments
           where status = 'accepted' and example_json is not null order by sense_id
        `).all()) saveLegacyExample(row.sense_id, JSON.parse(row.example_json) as PublicExample);
      }
    } finally {
      production.close();
    }
    if (hasTable(legacy, "on_demand_attempts")) {
      for (const row of legacy.query<{ attempt_json: string }, []>("select attempt_json from on_demand_attempts order by id").all()) {
        repository.recordAttempt(JSON.parse(row.attempt_json) as AttemptRecord);
      }
    }
    markImported(productionPath, "legacyJapaneseOverlay", overlayPath);
    return true;
  } finally {
    repository.close();
    lookup.close();
    legacy.close();
  }
}

function importEnglishOverlay(productionPath: string, overlayPath: string): boolean {
  if (!canImport(productionPath, overlayPath, "legacyEnglishOverlay")) return false;
  const legacy = new Database(overlayPath, { readonly: true });
  const repository = openEnglishEnrichmentRepository(productionPath);
  try {
    if (hasTable(legacy, "english_entries")) {
      for (const row of legacy.query<{ entry_json: string }, []>("select entry_json from english_entries order by entry_id").all()) {
        repository.saveEntry(legacyEnglishEntry(JSON.parse(row.entry_json) as LegacyEnglishEntry), "en");
      }
    }
    if (hasTable(legacy, "english_examples")) {
      for (const row of legacy.query<{ sense_id: string; example_json: string }, []>(
        "select sense_id, example_json from english_examples order by sense_id"
      ).all()) repository.saveExample(row.sense_id, JSON.parse(row.example_json) as EnglishExample);
    }
    if (hasTable(legacy, "english_attempts")) {
      for (const row of legacy.query<{ attempt_json: string }, []>("select attempt_json from english_attempts order by id").all()) {
        repository.recordAttempt(JSON.parse(row.attempt_json) as AttemptRecord);
      }
    }
    markImported(productionPath, "legacyEnglishOverlay", overlayPath);
    return true;
  } finally {
    repository.close();
    legacy.close();
  }
}

type LegacyEnglishEntry = Omit<EnglishEntry, "senses" | "pronunciations"> & {
  pronunciations: Array<{ ipa: string; region?: string; evidenceIds?: string[] }>;
  senses: Array<Omit<EnglishEntry["senses"][number], "lang" | "glosses"> & { definition: string }>;
};

/**
 * A legacy overlay record held one flat sense list with a single definition
 * string. It is read back as an English-explained group so that the sense,
 * not the table, carries the explanation language.
 */
function legacyEnglishEntry(entry: LegacyEnglishEntry): EnglishEntry {
  return {
    ...entry,
    pronunciations: entry.pronunciations.map((pronunciation) => ({
      ipa: pronunciation.ipa,
      ...(pronunciation.region ? { region: pronunciation.region } : {}),
      source: pronunciation.evidenceIds?.[0]?.split(":")[0] ?? "legacy",
      ...(pronunciation.evidenceIds?.[0] ? { sourceRef: pronunciation.evidenceIds[0] } : {})
    })),
    senses: entry.senses.map(({ definition, ...sense }) => ({
      ...sense,
      lang: "en" as const,
      glosses: [{
        text: definition,
        source: sense.provenance === "generated" ? "generated" : sense.evidenceIds[0]?.split(":")[0] ?? "legacy",
        reviewStatus: sense.provenance === "generated" ? ("checked" as const) : ("source" as const)
      }]
    }))
  };
}

function canImport(productionPath: string, overlayPath: string, marker: string): boolean {
  if (resolve(productionPath) === resolve(overlayPath) || !existsSync(overlayPath)) return false;
  const db = new Database(productionPath, { readonly: true });
  try {
    return !db.query<{ value: string }, [string]>("select value from production_metadata where key = ?").get(marker);
  } finally {
    db.close();
  }
}

function markImported(productionPath: string, marker: string, overlayPath: string): void {
  const db = new Database(productionPath);
  try {
    db.prepare("insert or replace into production_metadata (key, value) values (?, ?)")
      .run(marker, resolve(overlayPath));
  } finally {
    db.close();
  }
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(
    "select name from sqlite_master where type = 'table' and name = ?"
  ).get(table));
}

/**
 * Splits one legacy multi-language record into independent entry-language
 * groups. Sense identifiers become language-scoped so that later authoring or
 * review in one language cannot collide with another language's content.
 */
function splitLegacyEntry(entry: PublicLookupItem): Array<[ApiLang, PublicLookupItem]> {
  const languages = new Set<ApiLang>();
  for (const sense of entry.senses) {
    for (const gloss of sense.glosses) {
      const lang = parseApiLang(gloss.lang ?? "en");
      if (lang) languages.add(lang);
    }
  }
  return Array.from(languages, (lang) => {
    const senses = entry.senses.flatMap((sense) => {
      const glosses = sense.glosses.filter((gloss) => (gloss.lang ?? "en") === lang);
      if (glosses.length === 0) return [];
      return [{ ...sense, id: `${sense.id}:${lang}`, glosses }];
    }).map((sense, index) => ({ ...sense, position: index + 1 }));
    return [lang, { ...entry, senses }] as [ApiLang, PublicLookupItem];
  });
}

/**
 * Resolves a legacy example, which named one shared sense, onto the
 * language-scoped senses that own its paired sentences. Each target keeps
 * only its own language's sentence.
 */
function legacyExampleTargets(
  production: Database,
  senseId: string,
  example: PublicExample
): Array<[string, PublicExample]> {
  const senseExists = production.query<{ id: string }, [string]>("select id from ja_senses where id = ?");
  if (senseExists.get(senseId)) return [[senseId, example]];
  const targets: Array<[string, PublicExample]> = [];
  for (const translation of example.translations) {
    const lang = parseApiLang(translation.lang);
    if (!lang) continue;
    const targetId = `${senseId}:${lang}`;
    if (!senseExists.get(targetId)) continue;
    targets.push([targetId, { ...example, translations: [{ lang, text: translation.text }] }]);
  }
  return targets;
}
