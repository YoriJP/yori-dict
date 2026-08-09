import { Database } from "bun:sqlite";
import { insertRow, removeDatabaseFiles } from "./canonical-store";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { englishEntryId, englishSenseId, normalizeEnglishLookupTerm } from "./english-dictionary";
import {
  importOpenEnglishWordNetEntry,
  importWiktionaryEntry,
  englishSourceCredits,
  oewnAttribution,
  oewnLicense,
  wiktionaryAttribution,
  wiktionaryLicense,
  type OewnLexicalEntry,
  type OewnSynset
} from "./english-import";
import {
  createEnglishSchema,
  englishSchemaVersion,
  hasEnglishSchema,
  readCoverage,
  type LanguageCoverage
} from "./english-schema";
import {
  classifySourceRecord,
  importJapaneseWordNetEvidence,
  importTaiwanTerminology,
  type IliMapping,
  type JapaneseWordNetRecord,
  type TaiwanTerminologyRecord
} from "../scripts/english-evidence-sources";
import { openZipFile, type ZipArchive } from "./stored-zip";
import type { EnglishSourceRecord } from "./english-types";

/**
 * The explicit English source policy.
 *
 * Open English WordNet is the primary sense inventory because it has the
 * broader coverage, and its lexical-entry editorial order is what canonical
 * storage keeps. Simple English Wiktionary is fallback and reference: it
 * supplies the whole entry for a headword Open English WordNet does not carry,
 * and otherwise only fills a pronunciation gap or is admitted one sense at a
 * time through an explicit mapping that names an exact evidence identifier.
 * Nothing here compares two differently worded trusted definitions, and no
 * model is involved.
 */
export const englishSourcePolicy = {
  primary: "open-english-wordnet",
  fallback: "wiktionary",
  ja: "japanese-wordnet through a validated Princeton WordNet/ILI mapping",
  "zh-tw": "Taiwan government terminology inside its stated domain"
} as const;

/**
 * A pinned source that may publish canonical senses in an explanation
 * language other than English.
 *
 * Both are read through the same gate the evidence pipeline uses
 * (`classifySourceRecord`): a record becomes canonical only when it carries its
 * own target-language sense text, reaches the English entry through an exact
 * source identifier or a validated mapping, and records license, attribution
 * and version. A bare term pair or an unmapped record stays evidence and
 * publishes nothing.
 */
export type EnglishLanguageSourceInput =
  | {
      lang: "ja";
      source: "japanese-wordnet";
      version: string;
      /** JSONL of `{synset, lemma, lang, definition}` records. */
      file: string;
      /** JSONL of `{synset, ili, pwnSynset, validated}` mapping rows. */
      mappings: string;
      mappingSource: string;
      mappingVersion: string;
      license: string;
      attribution: string;
      sha256?: string;
      url?: string;
    }
  | {
      lang: "zh-tw";
      source: "taiwan-terminology";
      /** Pinned dataset version; each row also keeps the version it declares. */
      version: string;
      /** JSONL of Taiwan government terminology records with their own provenance. */
      file: string;
      license: string;
      attribution: string;
      sha256?: string;
      url?: string;
    };

export type EnglishLanguageImportResult = {
  /** Records the gate accepted for direct import. */
  eligible: number;
  /** Senses actually published, after resolving the English entry. */
  imported: number;
  /** Records that stay evidence because the direct-import contract is unmet. */
  evidenceOnly: number;
  /** Eligible records whose English entry this rebuild does not carry. */
  unmatched: number;
  /** Records the mapped-source importer rejected outright. */
  rejected: number;
};

export type EnglishSourceInput = {
  source: "open-english-wordnet" | "wiktionary";
  version: string;
  file: string;
  sha256?: string;
  url?: string;
  license?: string;
  attribution?: string;
};

export type EnglishRebuildOptions = {
  /** Pinned source archives, in the shape of `sources/english/source-lock.json`. */
  sources: EnglishSourceInput[];
  out: string;
  /** Release version recorded in the rebuilt database; defaults to the primary source version. */
  version?: string;
  /**
   * JSONL files whose rows name an exact fallback evidence identifier to admit
   * as one extra canonical sense: `{"evidenceId": "wiktionary:..."}`.
   */
  secondaryMappings?: string[];
  /**
   * Pinned sources for explanation languages other than English. They add
   * sibling sense groups to entries the English inventory already carries;
   * they never create, reorder or rewrite the English group.
   */
  languageSources?: EnglishLanguageSourceInput[];
  /** Limits which lexical-entry files of the archive are read. Tests rebuild a slice. */
  wordnetEntryFiles?: string[] | null;
  /**
   * Database whose accepted generated content is carried into the rebuild.
   * Defaults to the output path, so an ordinary rebuild keeps its own
   * accepted enrichment.
   */
  retainFrom?: string | null;
};

export type EnglishRebuildResult = {
  path: string;
  entries: number;
  coverage: Record<string, LanguageCoverage>;
  primary: { entries: number; senses: number };
  fallback: { entries: number; senses: number; referenceOnly: number };
  secondary: { imported: number; droppedUnknownEvidence: number };
  pronunciations: { primary: number; fallback: number };
  retained: { entries: number; groups: number; examples: number };
  /** Direct-import outcome per explanation language other than English. */
  languages: Record<string, EnglishLanguageImportResult>;
};

type PendingEntry = {
  lookupTerm: string;
  headword: string;
  forms: Set<string>;
  records: EnglishSourceRecord[];
};

type RetainedEntry = {
  entry: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  pronunciations: Array<Record<string, unknown>>;
  lookupTerms: Array<Record<string, unknown>>;
  senses: Array<Record<string, unknown>>;
  glosses: Array<Record<string, unknown>>;
  examples: Array<Record<string, unknown>>;
  generations: Array<Record<string, unknown>>;
};

/**
 * One accepted authored language group on an entry the sources still provide.
 * The entry itself is imported, so only this language's own senses, glosses,
 * examples, and generation provenance are carried across a rebuild.
 */
type RetainedGroup = {
  entryId: string;
  lang: string;
  senses: Array<Record<string, unknown>>;
  glosses: Array<Record<string, unknown>>;
  examples: Array<Record<string, unknown>>;
  generations: Array<Record<string, unknown>>;
};

type Retained = {
  entries: RetainedEntry[];
  groups: RetainedGroup[];
  examples: Array<Record<string, unknown>>;
  /** Generations referenced by retained examples on imported senses. */
  exampleGenerations: Array<Record<string, unknown>>;
};

/**
 * Rebuilds the whole English dictionary from pinned inputs into a fresh file
 * and only then replaces the previous database. A failed rebuild throws with
 * the previous file untouched.
 */
export async function rebuildEnglishDictionary(
  options: EnglishRebuildOptions
): Promise<EnglishRebuildResult> {
  const out = resolve(options.out);
  const staging = `${out}.rebuild-${process.pid}-${Date.now()}.tmp`;
  await mkdir(dirname(out), { recursive: true });
  await removeDatabaseFiles(staging);

  const retainFrom = options.retainFrom === undefined ? out : options.retainFrom;
  const retained = retainFrom && existsSync(retainFrom) ? readRetained(retainFrom) : emptyRetained();

  const db = new Database(staging, { create: true });
  try {
    const result = await buildInto(db, options, retained);
    db.close();
    await removeDatabaseFiles(out);
    await rename(staging, out);
    return { ...result, path: out };
  } catch (error) {
    try {
      db.close();
    } catch {
      // The staging database is discarded either way.
    }
    await removeDatabaseFiles(staging);
    throw error;
  }
}

async function buildInto(
  db: Database,
  options: EnglishRebuildOptions,
  retained: Retained
): Promise<Omit<EnglishRebuildResult, "path">> {
  db.exec("pragma journal_mode = OFF; pragma synchronous = OFF;");
  createEnglishSchema(db);

  const primarySource = options.sources.find(({ source }) => source === englishSourcePolicy.primary);
  if (!primarySource) throw new Error("The English rebuild requires the primary Open English WordNet source");
  const fallbackSource = options.sources.find(({ source }) => source === englishSourcePolicy.fallback) ?? null;

  const entries = new Map<string, PendingEntry>();
  const primaryCounts = await importPrimary(primarySource, options.wordnetEntryFiles ?? null, entries);

  const reference = fallbackSource
    ? await importFallback(fallbackSource, entries)
    : { entries: 0, senses: 0, referenceOnly: 0, byEvidenceId: new Map<string, ReferenceSense>(), byTerm: new Map<string, EnglishSourceRecord[]>() };

  const secondary = await admitSecondary(options.secondaryMappings ?? [], reference.byEvidenceId, entries);

  writeMetadata(db, options, primarySource, fallbackSource);
  const pronunciations = writeEntries(db, entries, reference.byTerm);
  const languages = await importLanguageGroups(db, options.languageSources ?? [], entries);
  const retainedResult = restoreRetained(db, retained);

  return {
    entries: db.query<{ count: number }, []>("select count(*) as count from en_entries").get()?.count ?? 0,
    coverage: readCoverage(db),
    primary: primaryCounts,
    fallback: { entries: reference.entries, senses: reference.senses, referenceOnly: reference.referenceOnly },
    secondary,
    pronunciations,
    retained: retainedResult,
    languages
  };
}

/** One canonical sense to publish in an explanation language other than English. */
type LanguageSense = {
  lookupTerm: string;
  evidenceId: string;
  definition: string;
  partOfSpeech: string;
  domains: string[];
  sourceName: string;
  sourceVersion: string;
  sourceEntryId: string;
  license: string;
  attribution: string;
};

/**
 * Publishes sibling explanation-language groups from pinned mapped sources.
 *
 * Each language group gets its own sense identifiers and its own positions
 * starting at 1. The English group is read only, for the concept mapping and
 * the part-of-speech label; nothing here touches an English row.
 */
async function importLanguageGroups(
  db: Database,
  inputs: EnglishLanguageSourceInput[],
  entries: Map<string, PendingEntry>
): Promise<Record<string, EnglishLanguageImportResult>> {
  const results: Record<string, EnglishLanguageImportResult> = {};
  if (inputs.length === 0) return results;

  const bySynset = new Map<string, Array<{ lookupTerm: string; partOfSpeech: string }>>();
  for (const pending of entries.values()) {
    for (const record of pending.records) {
      for (const sense of record.senses) {
        if (!sense.synset) continue;
        const key = conceptKey(sense.synset);
        const holders = bySynset.get(key) ?? [];
        if (!holders.some((holder) => holder.lookupTerm === pending.lookupTerm)) {
          holders.push({ lookupTerm: pending.lookupTerm, partOfSpeech: sense.partOfSpeech });
        }
        bySynset.set(key, holders);
      }
    }
  }

  const senses: LanguageSense[] = [];
  for (const input of inputs) {
    const result = results[input.lang] ??= { eligible: 0, imported: 0, evidenceOnly: 0, unmatched: 0, rejected: 0 };
    const produced = input.source === "japanese-wordnet"
      ? await readJapaneseWordNetMeanings(input, bySynset, result)
      : await readTaiwanTerminologyMeanings(input, entries, result);
    senses.push(...produced);
  }

  writeLanguageSenses(db, senses, results);
  return results;
}

/** Japanese WordNet and Open English WordNet both key concepts on the PWN identifier. */
function conceptKey(synset: string): string {
  return synset.replace(/^[a-z]+-/, "");
}

async function readJapaneseWordNetMeanings(
  input: Extract<EnglishLanguageSourceInput, { source: "japanese-wordnet" }>,
  bySynset: Map<string, Array<{ lookupTerm: string; partOfSpeech: string }>>,
  result: EnglishLanguageImportResult
): Promise<LanguageSense[]> {
  const records = (await readLines(resolve(input.file))).map((line) => JSON.parse(line) as JapaneseWordNetRecord);
  const mappings = (await readLines(resolve(input.mappings))).map((line) => JSON.parse(line) as IliMapping);
  const imported = importJapaneseWordNetEvidence(records, mappings, {
    version: input.version,
    license: input.license,
    attribution: input.attribution,
    mappingSource: input.mappingSource,
    mappingVersion: input.mappingVersion
  });
  result.rejected += imported.rejected.length;

  const senses: LanguageSense[] = [];
  for (const row of imported.accepted) {
    if (row.role !== "direct-import-candidate" || !row.definition) {
      result.evidenceOnly += 1;
      continue;
    }
    result.eligible += 1;
    const holders = bySynset.get(conceptKey(row.mapping.pwnSynset)) ?? [];
    if (holders.length === 0) {
      result.unmatched += 1;
      continue;
    }
    for (const holder of holders) {
      senses.push({
        lookupTerm: holder.lookupTerm,
        evidenceId: row.evidenceId,
        definition: row.definition,
        partOfSpeech: holder.partOfSpeech,
        domains: [],
        sourceName: "japanese-wordnet",
        sourceVersion: row.sourceVersion,
        sourceEntryId: `${row.synset}:${row.lemma}`,
        license: input.license,
        attribution: `${input.attribution}; mapped through ${row.mapping.mappingSource} ${row.mapping.mappingVersion}`
      });
    }
  }
  return senses;
}

async function readTaiwanTerminologyMeanings(
  input: Extract<EnglishLanguageSourceInput, { source: "taiwan-terminology" }>,
  entries: Map<string, PendingEntry>,
  result: EnglishLanguageImportResult
): Promise<LanguageSense[]> {
  const records = (await readLines(resolve(input.file))).map((line) => JSON.parse(line) as TaiwanTerminologyRecord);
  const imported = importTaiwanTerminology(records, { license: input.license });
  result.rejected += imported.rejected.length;

  const senses: LanguageSense[] = [];
  for (const row of imported.accepted) {
    // Re-run the gate here rather than trusting the role written into the file.
    const classification = classifySourceRecord({
      sourceId: "taiwan-terminology",
      sourceVersion: row.version,
      recordId: row.evidenceId,
      targetLocale: "zh-tw",
      recordLocale: "zh-tw",
      hasTargetLanguageSenseStructure: row.definition !== null,
      matchedBy: "source-identifier",
      license: input.license,
      attribution: row.attribution
    });
    if (!classification.eligible || !row.definition) {
      result.evidenceOnly += 1;
      continue;
    }
    result.eligible += 1;
    const lookupTerm = normalizeEnglishLookupTerm(row.termPair.english);
    const pending = entries.get(lookupTerm);
    // Terminology never creates an English headword; it explains one that the
    // English inventory already carries.
    if (!pending || pending.records.length === 0) {
      result.unmatched += 1;
      continue;
    }
    senses.push({
      lookupTerm,
      evidenceId: row.evidenceId,
      definition: row.definition,
      partOfSpeech: pending.records[0].senses[0]?.partOfSpeech ?? "noun",
      // The row is authoritative only inside its stated domain, so the domain
      // travels with the published sense.
      domains: [row.domain],
      sourceName: "taiwan-terminology",
      sourceVersion: row.version,
      sourceEntryId: `${row.agency}:${row.dataset}:${row.evidenceId}`,
      license: input.license,
      attribution: `${row.attribution} (${row.agency}, ${row.dataset} ${row.version})`
    });
  }
  return senses;
}

function writeLanguageSenses(
  db: Database,
  senses: LanguageSense[],
  results: Record<string, EnglishLanguageImportResult>
): void {
  const langOf = (sense: LanguageSense) => sense.sourceName === "japanese-wordnet" ? "ja" : "zh-tw";
  const insertSense = db.prepare(`
    insert or ignore into en_senses (
      id, entry_id, lang, position, part_of_speech, registers, regions, domains, dated, usage,
      provenance, source_name, source_version, source_ref, generation_id
    ) values (?, ?, ?, ?, ?, '[]', '[]', ?, 0, '[]', 'source', ?, ?, ?, null)
  `);
  const insertGloss = db.prepare(`
    insert or ignore into en_glosses (sense_id, position, text, source, review_status, type)
    values (?, 1, ?, ?, 'source', null)
  `);
  const insertEntrySource = db.prepare(`
    insert or ignore into en_entry_sources
      (entry_id, source, source_version, source_entry_id, license, attribution)
    values (?, ?, ?, ?, ?, ?)
  `);
  const positions = new Map<string, number>();

  db.transaction(() => {
    for (const sense of senses) {
      const lang = langOf(sense);
      const entryId = englishEntryId(sense.lookupTerm);
      if (!db.query<{ id: string }, [string]>("select id from en_entries where id = ?").get(entryId)) {
        results[lang].unmatched += 1;
        continue;
      }
      const key = `${entryId}:${lang}`;
      const position = (positions.get(key) ?? 0) + 1;
      positions.set(key, position);
      const senseId = englishSenseId(`${lang}:${sense.evidenceId}:${sense.lookupTerm}`);
      insertSense.run(
        senseId,
        entryId,
        lang,
        position,
        sense.partOfSpeech,
        JSON.stringify(sense.domains),
        sense.sourceName,
        sense.sourceVersion,
        sense.evidenceId
      );
      insertGloss.run(senseId, sense.definition, sense.sourceName);
      insertEntrySource.run(
        entryId,
        sense.sourceName,
        sense.sourceVersion,
        sense.sourceEntryId,
        sense.license,
        sense.attribution
      );
      results[lang].imported += 1;
    }
  })();
}

function writeMetadata(
  db: Database,
  options: EnglishRebuildOptions,
  primary: EnglishSourceInput,
  fallback: EnglishSourceInput | null
): void {
  const insert = db.prepare("insert or replace into en_metadata (key, value) values (?, ?)");
  insert.run("schemaVersion", englishSchemaVersion);
  insert.run("dictionaryVersion", options.version ?? primary.version);
  insert.run("openEnglishWordNetVersion", primary.version);
  if (fallback) insert.run("simpleWiktionaryVersion", fallback.version);
  insert.run("sourcePolicy", JSON.stringify({
    primary: englishSourcePolicy.primary,
    fallback: englishSourcePolicy.fallback,
    secondary: "exact evidence identifier mappings only",
    // Every explanation language names its own direct-import source. Anything
    // else about that language is authored and reviewed, never converted.
    languages: {
      en: `${englishSourcePolicy.primary} then ${englishSourcePolicy.fallback}`,
      ja: englishSourcePolicy.ja,
      "zh-tw": englishSourcePolicy["zh-tw"]
    }
  }));
  insert.run("sources", JSON.stringify([
    ...options.sources.map((source) => ({
      source: source.source,
      ...sourceCredit(source.source),
      lang: "en",
      version: source.version,
      license: source.license ?? defaultLicense(source.source),
      attribution: source.attribution ?? defaultAttribution(source.source),
      // The archive's own name, never the builder's path: a manifest describes
      // the pinned artifact, and must read the same on any machine.
      file: basename(source.file),
      ...(source.sha256 ? { sha256: source.sha256 } : {}),
      ...(source.url ? { url: source.url } : {}),
      role: source.source === englishSourcePolicy.primary ? "primary" : "fallback"
    })),
    ...(options.languageSources ?? []).map((source) => ({
      source: source.source,
      ...sourceCredit(source.source),
      lang: source.lang,
      version: source.version,
      license: source.license,
      attribution: source.attribution,
      file: basename(source.file),
      ...(source.sha256 ? { sha256: source.sha256 } : {}),
      ...(source.url ? { url: source.url } : {}),
      role: "language-direct-import",
      ...(source.source === "japanese-wordnet"
        ? {
            mappingSource: source.mappingSource,
            mappingVersion: source.mappingVersion,
            mappings: basename(source.mappings)
          }
        : {})
    }))
  ]));
}

/**
 * Reads the primary inventory. Entries are visited in the archive's own file
 * and key order, and each entry keeps its part-of-speech blocks and their
 * `sense` arrays in that same order: this is the recovered lexical-entry
 * editorial order, and nothing downstream re-sorts by source name or synset id.
 */
async function importPrimary(
  source: EnglishSourceInput,
  entryFiles: string[] | null,
  entries: Map<string, PendingEntry>
): Promise<{ entries: number; senses: number }> {
  const archive = await openArchive(resolve(source.file));
  const names = archive.names;
  const synsets = new Map<string, OewnSynset>();
  for (const name of names.filter((name) => /^(noun|verb|adj|adv)\..+\.json$/.test(name)).sort()) {
    for (const [id, synset] of Object.entries(readArchiveJson(archive, name))) {
      if (synset && typeof synset === "object" && !Array.isArray(synset)) synsets.set(id, synset as OewnSynset);
    }
  }

  const wanted = entryFiles ? new Set(entryFiles) : null;
  const counts = { entries: 0, senses: 0 };
  for (const name of names.filter((name) => /^entries-.+\.json$/.test(name)).sort()) {
    if (wanted && !wanted.has(name)) continue;
    const document = readArchiveJson(archive, name);
    for (const [headword, raw] of Object.entries(document)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const records = importOpenEnglishWordNetEntry(
        headword,
        raw as OewnLexicalEntry,
        (id) => synsets.get(id),
        source.version
      );
      if (records.length === 0) continue;
      counts.entries += 1;
      counts.senses += records.reduce((total, record) => total + record.senses.length, 0);
      for (const record of records) {
        const pending = pendingEntry(entries, record.headword);
        pending.records.push(record);
        for (const form of record.forms) pending.forms.add(form);
      }
    }
  }
  return counts;
}

type ReferenceSense = { record: EnglishSourceRecord; index: number };

/**
 * Reads the fallback source. A record becomes canonical only when the primary
 * inventory has no entry for that headword; otherwise it is reference content
 * that a later explicit mapping may name, and whose pronunciations may fill a
 * gap the primary entry left.
 */
async function importFallback(
  source: EnglishSourceInput,
  entries: Map<string, PendingEntry>
): Promise<{
  entries: number;
  senses: number;
  referenceOnly: number;
  byEvidenceId: Map<string, ReferenceSense>;
  byTerm: Map<string, EnglishSourceRecord[]>;
}> {
  const byEvidenceId = new Map<string, ReferenceSense>();
  const byTerm = new Map<string, EnglishSourceRecord[]>();
  const seenRecordIds = new Map<string, number>();
  const covered = new Set(entries.keys());
  let admitted = 0;
  let senses = 0;
  let referenceOnly = 0;

  for (const line of await readLines(resolve(source.file))) {
    for (const record of importWiktionaryEntry(JSON.parse(line), source.version, {
      attribution: source.attribution ?? wiktionaryAttribution
    })) {
      const occurrence = (seenRecordIds.get(record.sourceEntryId) ?? 0) + 1;
      seenRecordIds.set(record.sourceEntryId, occurrence);
      const unique = occurrence === 1 ? record : withRecordSuffix(record, occurrence);
      const term = normalizeEnglishLookupTerm(unique.headword);
      byTerm.set(term, [...(byTerm.get(term) ?? []), unique]);
      unique.senses.forEach((sense, index) => byEvidenceId.set(sense.evidenceId, { record: unique, index }));
      // Word forms are refused upstream, per sense, on the source's own
      // categorisation. Stripping the surface here as a second gate would be
      // guessing where the source has already told us, and the guess is wrong
      // far more often than it is right: `his` strips to the covered `hi`, and
      // `us` to `u`, so a lexeme the primary inventory simply lacks would be
      // deleted and its lookup answered with an unrelated entry.
      if (covered.has(term)) {
        referenceOnly += 1;
        continue;
      }
      const pending = pendingEntry(entries, unique.headword);
      if (pending.records.length === 0) admitted += 1;
      pending.records.push(unique);
      senses += unique.senses.length;
    }
  }
  return { entries: admitted, senses, referenceOnly, byEvidenceId, byTerm };
}

/**
 * Admits secondary canonical senses. A row must name an exact evidence
 * identifier that the fallback source really produced; there is no matching by
 * wording and no model comparison.
 */
async function admitSecondary(
  paths: string[],
  byEvidenceId: Map<string, ReferenceSense>,
  entries: Map<string, PendingEntry>
): Promise<{ imported: number; droppedUnknownEvidence: number }> {
  const stats = { imported: 0, droppedUnknownEvidence: 0 };
  const admitted = new Set<string>();
  for (const path of paths) {
    for (const line of await readLines(resolve(path))) {
      const row = JSON.parse(line) as { evidenceId?: unknown };
      if (typeof row.evidenceId !== "string" || !row.evidenceId.trim()) {
        throw new Error(`English secondary mapping row has no evidenceId: ${line}`);
      }
      if (admitted.has(row.evidenceId)) throw new Error(`Duplicate English secondary mapping: ${row.evidenceId}`);
      admitted.add(row.evidenceId);
      const reference = byEvidenceId.get(row.evidenceId);
      // The pinned source may no longer carry the mapped sense. A deliberate
      // rebuild drops it rather than failing the whole import.
      if (!reference) {
        stats.droppedUnknownEvidence += 1;
        continue;
      }
      const pending = entries.get(normalizeEnglishLookupTerm(reference.record.headword));
      if (!pending) {
        stats.droppedUnknownEvidence += 1;
        continue;
      }
      if (pending.records.some((record) => record.sourceEntryId === reference.record.sourceEntryId
        && record.source === reference.record.source)) continue;
      pending.records.push({
        ...reference.record,
        pronunciations: [],
        senses: [reference.record.senses[reference.index]]
      });
      stats.imported += 1;
    }
  }
  return stats;
}

function pendingEntry(entries: Map<string, PendingEntry>, headword: string): PendingEntry {
  const lookupTerm = normalizeEnglishLookupTerm(headword);
  const existing = entries.get(lookupTerm);
  if (existing) {
    // The display headword prefers the source spelling that already matches the
    // lookup term, so casing only survives when no plain spelling exists.
    if (existing.headword !== lookupTerm && headword.trim().normalize("NFKC") === lookupTerm) {
      existing.headword = lookupTerm;
    }
    return existing;
  }
  const created: PendingEntry = {
    lookupTerm,
    headword: headword.trim().normalize("NFKC"),
    forms: new Set(),
    records: []
  };
  entries.set(lookupTerm, created);
  return created;
}

function withRecordSuffix(record: EnglishSourceRecord, occurrence: number): EnglishSourceRecord {
  const sourceEntryId = `${record.sourceEntryId}:${occurrence}`;
  return {
    ...record,
    sourceEntryId,
    pronunciations: record.pronunciations.map((pronunciation, index) => ({
      ...pronunciation,
      evidenceId: `${record.source}:${sourceEntryId}:pronunciation:${index + 1}`
    })),
    senses: record.senses.map((sense, index) => ({
      ...sense,
      evidenceId: `${record.source}:${sourceEntryId}:${index + 1}`
    }))
  };
}

function writeEntries(
  db: Database,
  entries: Map<string, PendingEntry>,
  referenceByTerm: Map<string, EnglishSourceRecord[]>
): { primary: number; fallback: number } {
  const insertEntry = db.prepare(
    "insert into en_entries (id, source, source_id, headword, lookup_term, headword_language) values (?, ?, ?, ?, ?, 'en')"
  );
  const insertEntrySource = db.prepare(`
    insert or ignore into en_entry_sources
      (entry_id, source, source_version, source_entry_id, license, attribution)
    values (?, ?, ?, ?, ?, ?)
  `);
  const insertPronunciation = db.prepare(`
    insert or ignore into en_pronunciations (entry_id, position, ipa, region, source_name, source_version, source_ref)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLookup = db.prepare("insert or ignore into en_lookup_terms (term, entry_id) values (?, ?)");
  const insertSense = db.prepare(`
    insert into en_senses (
      id, entry_id, lang, position, part_of_speech, registers, regions, domains, dated, usage,
      provenance, source_name, source_version, source_ref, generation_id
    ) values (?, ?, 'en', ?, ?, ?, ?, ?, ?, ?, 'source', ?, ?, ?, null)
  `);
  const insertGloss = db.prepare(`
    insert or ignore into en_glosses (sense_id, position, text, source, review_status, type)
    values (?, ?, ?, ?, 'source', null)
  `);
  const insertExample = db.prepare(`
    insert or ignore into en_examples
      (sense_id, position, text, translations, source, source_name, source_id, review_status, generation_id)
    values (?, ?, ?, '[]', 'sourced', ?, ?, 'source', null)
  `);

  const counts = { primary: 0, fallback: 0 };
  db.transaction(() => {
    for (const pending of entries.values()) {
      if (pending.records.length === 0) continue;
      const first = pending.records[0];
      const entryId = englishEntryId(pending.lookupTerm);
      insertEntry.run(
        entryId,
        first.source,
        `${first.source}:${first.sourceEntryId}`,
        pending.headword,
        pending.lookupTerm
      );
      insertLookup.run(pending.lookupTerm, entryId);
      for (const form of pending.forms) {
        const term = normalizeEnglishLookupTerm(form);
        if (term) insertLookup.run(term, entryId);
      }

      const seenSources = new Set<string>();
      let position = 0;
      let pronunciationPosition = 0;
      for (const record of pending.records) {
        const sourceKey = `${record.source}:${record.sourceEntryId}`;
        if (!seenSources.has(sourceKey)) {
          seenSources.add(sourceKey);
          insertEntrySource.run(
            entryId,
            record.source,
            record.sourceVersion,
            record.sourceEntryId,
            record.license,
            record.attribution
          );
        }
        for (const pronunciation of record.pronunciations) {
          pronunciationPosition += 1;
          insertPronunciation.run(
            entryId,
            pronunciationPosition,
            pronunciation.ipa,
            pronunciation.region ?? null,
            record.source,
            record.sourceVersion,
            pronunciation.evidenceId
          );
          counts[record.source === englishSourcePolicy.primary ? "primary" : "fallback"] += 1;
        }
        for (const sense of record.senses) {
          position += 1;
          const senseId = englishSenseId(sense.evidenceId);
          insertSense.run(
            senseId,
            entryId,
            position,
            sense.partOfSpeech,
            JSON.stringify(sense.registers),
            JSON.stringify(sense.regions),
            JSON.stringify(sense.domains),
            sense.dated ? 1 : 0,
            JSON.stringify(sense.usage),
            record.source,
            record.sourceVersion,
            sense.evidenceId
          );
          sense.glosses.forEach((gloss, index) => insertGloss.run(senseId, index + 1, gloss, record.source));
          sense.examples.forEach((example, index) => insertExample.run(
            senseId,
            index + 1,
            example.text,
            example.sourceName ?? record.source,
            example.sourceId ?? null
          ));
        }
      }

      // A fallback pronunciation only ever fills a gap the primary entry left,
      // matched on the exact headword. It never replaces or reorders one.
      if (pronunciationPosition === 0) {
        for (const record of referenceByTerm.get(pending.lookupTerm) ?? []) {
          for (const pronunciation of record.pronunciations) {
            pronunciationPosition += 1;
            insertPronunciation.run(
              entryId,
              pronunciationPosition,
              pronunciation.ipa,
              pronunciation.region ?? null,
              record.source,
              record.sourceVersion,
              pronunciation.evidenceId
            );
            counts.fallback += 1;
          }
          if (pronunciationPosition > 0) {
            insertEntrySource.run(
              entryId,
              record.source,
              record.sourceVersion,
              record.sourceEntryId,
              record.license,
              record.attribution
            );
            break;
          }
        }
      }
    }
  })();
  return counts;
}

function emptyRetained(): Retained {
  return { entries: [], groups: [], examples: [], exampleGenerations: [] };
}

/**
 * Accepted enrichment survives a rebuild with its own provenance: generated
 * entries are carried whole, accepted language groups authored for an imported
 * entry are carried per language, and generated examples on imported senses
 * are re-attached by their sense identifier.
 */
function readRetained(path: string): Retained {
  const db = new Database(path, { readonly: true });
  try {
    if (!hasEnglishSchema(db)) return emptyRetained();
    const generatedIds = db.query<{ id: string }, []>(
      "select id from en_entries where source = 'generated' order by id"
    ).all().map((row) => row.id);

    const entries = generatedIds.map<RetainedEntry>((entryId) => {
      const senses = db.query<Record<string, unknown>, [string]>(
        "select * from en_senses where entry_id = ? order by lang, position"
      ).all(entryId);
      const senseIds = senses.map((sense) => String(sense.id));
      return {
        entry: db.query<Record<string, unknown>, [string]>("select * from en_entries where id = ?").get(entryId)!,
        sources: db.query<Record<string, unknown>, [string]>(
          "select * from en_entry_sources where entry_id = ?"
        ).all(entryId),
        pronunciations: db.query<Record<string, unknown>, [string]>(
          "select * from en_pronunciations where entry_id = ? order by position"
        ).all(entryId),
        lookupTerms: db.query<Record<string, unknown>, [string]>(
          "select * from en_lookup_terms where entry_id = ?"
        ).all(entryId),
        senses,
        glosses: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from en_glosses where sense_id = ? order by position"
        ).all(senseId)),
        examples: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from en_examples where sense_id = ? order by position"
        ).all(senseId)),
        generations: db.query<Record<string, unknown>, [string, string]>(`
          select * from en_generations where id in (
            select generation_id from en_senses where entry_id = ? and generation_id is not null
            union
            select example.generation_id from en_examples example
              join en_senses sense on sense.id = example.sense_id
             where sense.entry_id = ? and example.generation_id is not null
          )
        `).all(entryId, entryId)
      };
    });

    // What enrichment usually produces is a language group under an imported
    // entry. It is retained per entry and language, because the entry itself
    // comes back from the sources.
    const groups = db.query<{ entry_id: string; lang: string }, []>(`
      select sense.entry_id as entry_id, sense.lang as lang
        from en_senses sense
        join en_entries entry on entry.id = sense.entry_id
       where sense.generation_id is not null and entry.source <> 'generated'
       group by sense.entry_id, sense.lang
       order by sense.entry_id, sense.lang
    `).all().map<RetainedGroup>(({ entry_id: entryId, lang }) => {
      const senses = db.query<Record<string, unknown>, [string, string]>(
        "select * from en_senses where entry_id = ? and lang = ? order by position"
      ).all(entryId, lang);
      const senseIds = senses.map((sense) => String(sense.id));
      return {
        entryId,
        lang,
        senses,
        glosses: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from en_glosses where sense_id = ? order by position"
        ).all(senseId)),
        examples: senseIds.flatMap((senseId) => db.query<Record<string, unknown>, [string]>(
          "select * from en_examples where sense_id = ? order by position"
        ).all(senseId)),
        generations: db.query<Record<string, unknown>, [string, string, string, string]>(`
          select * from en_generations where id in (
            select generation_id from en_senses
             where entry_id = ? and lang = ? and generation_id is not null
            union
            select example.generation_id from en_examples example
              join en_senses sense on sense.id = example.sense_id
             where sense.entry_id = ? and sense.lang = ? and example.generation_id is not null
          )
        `).all(entryId, lang, entryId, lang)
      };
    });

    const retainedSenseIds = new Set(groups.flatMap((group) => group.senses.map((sense) => String(sense.id))));
    const examples = db.query<Record<string, unknown>, []>(`
      select example.* from en_examples example
        join en_senses sense on sense.id = example.sense_id
        join en_entries entry on entry.id = sense.entry_id
       where example.source = 'generated' and entry.source <> 'generated'
       order by example.sense_id, example.position
    `).all().filter((example) => !retainedSenseIds.has(String(example.sense_id)));

    // A generated example on an imported sense carries its own generation
    // reference, so the row it points at is retained with it.
    const exampleGenerationIds = [...new Set(
      examples.map((example) => example.generation_id).filter((id): id is string => typeof id === "string")
    )];
    const exampleGenerations = exampleGenerationIds.length === 0 ? [] : db.query<Record<string, unknown>, string[]>(
      `select * from en_generations where id in (${exampleGenerationIds.map(() => "?").join(", ")})`
    ).all(...exampleGenerationIds);

    return { entries, groups, examples, exampleGenerations };
  } finally {
    db.close();
  }
}

function restoreRetained(
  db: Database,
  retained: Retained
): { entries: number; groups: number; examples: number } {
  let entries = 0;
  let groups = 0;
  let examples = 0;
  db.transaction(() => {
    for (const record of retained.entries) {
      const id = String(record.entry.id);
      const existing = db.query<{ id: string }, [string]>("select id from en_entries where id = ?").get(id)
        ?? db.query<{ id: string }, [string]>(
          "select id from en_entries where lookup_term = ?"
        ).get(String(record.entry.lookup_term));
      if (existing) {
        // The sources now provide this headword, so the imported entry is the
        // canonical one. The accepted language groups the entry was enriched
        // with are not source content, so they move onto it rather than being
        // dropped with the entry row they used to hang from.
        groups += reattachGroups(db, record, existing.id);
        continue;
      }
      insertRow(db, "en_entries", record.entry, false);
      for (const generation of record.generations) insertRow(db, "en_generations", generation, true);
      for (const source of record.sources) insertRow(db, "en_entry_sources", source, true);
      for (const pronunciation of record.pronunciations) insertRow(db, "en_pronunciations", pronunciation, true);
      for (const term of record.lookupTerms) insertRow(db, "en_lookup_terms", term, true);
      for (const sense of record.senses) insertRow(db, "en_senses", sense, false);
      for (const gloss of record.glosses) insertRow(db, "en_glosses", gloss, false);
      for (const example of record.examples) insertRow(db, "en_examples", example, false);
      entries += 1;
    }
    for (const group of retained.groups) {
      // The entry must still exist in the rebuilt sources, and the rebuild must
      // not already explain it in this language: imported content wins, and a
      // retained group never reorders it.
      if (!db.query<{ id: string }, [string]>("select id from en_entries where id = ?").get(group.entryId)) continue;
      if (db.query<{ id: string }, [string, string]>(
        "select id from en_senses where entry_id = ? and lang = ? limit 1"
      ).get(group.entryId, group.lang)) continue;
      for (const generation of group.generations) insertRow(db, "en_generations", generation, true);
      for (const sense of group.senses) insertRow(db, "en_senses", sense, false);
      for (const gloss of group.glosses) insertRow(db, "en_glosses", gloss, false);
      for (const example of group.examples) insertRow(db, "en_examples", example, false);
      groups += 1;
    }
    for (const generation of retained.exampleGenerations) {
      insertRow(db, "en_generations", generation, true);
    }
    for (const example of retained.examples) {
      const senseId = String(example.sense_id);
      if (!db.query<{ id: string }, [string]>("select id from en_senses where id = ?").get(senseId)) continue;
      // The rebuilt sense may have gained or lost imported examples, so the
      // retained one is appended rather than dropped onto a taken position.
      const next = db.query<{ position: number }, [string]>(
        "select coalesce(max(position), 0) + 1 as position from en_examples where sense_id = ?"
      ).get(senseId)!.position;
      insertRow(db, "en_examples", { ...example, position: next }, true);
      examples += 1;
    }
  })();
  return { entries, groups, examples };
}


/**
 * Moves a retained entry's accepted language groups onto an entry the rebuilt
 * sources now provide. A language the sources already explain is left alone:
 * imported content wins, and a retained group never reorders it.
 */
function reattachGroups(db: Database, record: RetainedEntry, entryId: string): number {
  const byLang = new Map<string, Array<Record<string, unknown>>>();
  for (const sense of record.senses) {
    const lang = String(sense.lang);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push(sense);
  }

  let moved = 0;
  for (const [lang, senses] of byLang) {
    // Only accepted enrichment travels; it is marked by its generation row.
    if (!senses.some((sense) => sense.generation_id !== null && sense.generation_id !== undefined)) continue;
    if (db.query<{ id: string }, [string, string]>(
      "select id from en_senses where entry_id = ? and lang = ? limit 1"
    ).get(entryId, lang)) continue;

    const senseIds = new Set(senses.map((sense) => String(sense.id)));
    for (const generation of record.generations) insertRow(db, "en_generations", generation, true);
    for (const sense of senses) insertRow(db, "en_senses", { ...sense, entry_id: entryId }, false);
    for (const gloss of record.glosses) {
      if (senseIds.has(String(gloss.sense_id))) insertRow(db, "en_glosses", gloss, false);
    }
    for (const example of record.examples) {
      if (senseIds.has(String(example.sense_id))) insertRow(db, "en_examples", example, false);
    }
    moved += 1;
  }
  return moved;
}

/**
 * A recognisable name and a resolvable home for one pinned source. An
 * unrecorded source contributes neither, so it is visibly missing from
 * `/v1/meta` rather than published as an attribution nobody can act on.
 */
function sourceCredit(source: string): { name?: string; url?: string } {
  return englishSourceCredits[source] ?? {};
}

function defaultLicense(source: string): string {
  return source === englishSourcePolicy.primary ? oewnLicense : wiktionaryLicense;
}

function defaultAttribution(source: string): string {
  return source === englishSourcePolicy.primary ? oewnAttribution : wiktionaryAttribution;
}

async function openArchive(path: string): Promise<ZipArchive> {
  if (!path.endsWith(".zip")) throw new Error(`Expected a zipped Open English WordNet archive: ${path}`);
  return openZipFile(path);
}

function readArchiveJson(archive: ZipArchive, name: string): Record<string, unknown> {
  return JSON.parse(archive.text(name)) as Record<string, unknown>;
}

async function readLines(path: string): Promise<string[]> {
  const text = path.endsWith(".gz")
    ? await new Response(Bun.file(path).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : await Bun.file(path).text();
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

