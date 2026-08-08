import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { englishEntryId, englishSenseId, normalizeEnglishLookupTerm } from "./english-dictionary";
import {
  importOpenEnglishWordNetEntry,
  importWiktionaryEntry,
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
  type EnglishLanguageCoverage
} from "./english-schema";
import type { EnglishSourceRecord } from "./english-types";

/**
 * The explicit English source policy.
 *
 * Open English WordNet is the primary meaning inventory because it has the
 * broader coverage, and its lexical-entry editorial order is what canonical
 * storage keeps. Simple English Wiktionary is fallback and reference: it
 * supplies the whole entry for a headword Open English WordNet does not carry,
 * and otherwise only fills a pronunciation gap or is admitted one meaning at a
 * time through an explicit mapping that names an exact evidence identifier.
 * Nothing here compares two differently worded trusted definitions, and no
 * model is involved.
 */
export const englishSourcePolicy = {
  primary: "open-english-wordnet",
  fallback: "wiktionary"
} as const;

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
   * as one extra canonical meaning: `{"evidenceId": "wiktionary:..."}`.
   */
  secondaryMappings?: string[];
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
  coverage: Record<string, EnglishLanguageCoverage>;
  primary: { entries: number; meanings: number };
  fallback: { entries: number; meanings: number; referenceOnly: number };
  secondary: { imported: number; droppedUnknownEvidence: number };
  pronunciations: { primary: number; fallback: number };
  retained: { entries: number; examples: number };
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

type Retained = { entries: RetainedEntry[]; examples: Array<Record<string, unknown>> };

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
    : { entries: 0, meanings: 0, referenceOnly: 0, byEvidenceId: new Map<string, ReferenceSense>(), byTerm: new Map<string, EnglishSourceRecord[]>() };

  const secondary = await admitSecondary(options.secondaryMappings ?? [], reference.byEvidenceId, entries);

  writeMetadata(db, options, primarySource, fallbackSource);
  const pronunciations = writeEntries(db, entries, reference.byTerm);
  const retainedResult = restoreRetained(db, retained);

  return {
    entries: db.query<{ count: number }, []>("select count(*) as count from en_entries").get()?.count ?? 0,
    coverage: readCoverage(db),
    primary: primaryCounts,
    fallback: { entries: reference.entries, meanings: reference.meanings, referenceOnly: reference.referenceOnly },
    secondary,
    pronunciations,
    retained: retainedResult
  };
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
    secondary: "exact evidence identifier mappings only"
  }));
  insert.run("sources", JSON.stringify(options.sources.map((source) => ({
    source: source.source,
    version: source.version,
    license: source.license ?? defaultLicense(source.source),
    attribution: source.attribution ?? defaultAttribution(source.source),
    file: source.file,
    ...(source.sha256 ? { sha256: source.sha256 } : {}),
    ...(source.url ? { url: source.url } : {}),
    role: source.source === englishSourcePolicy.primary ? "primary" : "fallback"
  }))));
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
): Promise<{ entries: number; meanings: number }> {
  const archive = resolve(source.file);
  const names = await listArchive(archive);
  const synsets = new Map<string, OewnSynset>();
  for (const name of names.filter((name) => /^(noun|verb|adj|adv)\..+\.json$/.test(name)).sort()) {
    for (const [id, synset] of Object.entries(await readArchiveJson(archive, name))) {
      if (synset && typeof synset === "object" && !Array.isArray(synset)) synsets.set(id, synset as OewnSynset);
    }
  }

  const wanted = entryFiles ? new Set(entryFiles) : null;
  const counts = { entries: 0, meanings: 0 };
  for (const name of names.filter((name) => /^entries-.+\.json$/.test(name)).sort()) {
    if (wanted && !wanted.has(name)) continue;
    const document = await readArchiveJson(archive, name);
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
      counts.meanings += records.reduce((total, record) => total + record.senses.length, 0);
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
  meanings: number;
  referenceOnly: number;
  byEvidenceId: Map<string, ReferenceSense>;
  byTerm: Map<string, EnglishSourceRecord[]>;
}> {
  const byEvidenceId = new Map<string, ReferenceSense>();
  const byTerm = new Map<string, EnglishSourceRecord[]>();
  const seenRecordIds = new Map<string, number>();
  const covered = new Set(entries.keys());
  let admitted = 0;
  let meanings = 0;
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
      if (covered.has(term)) {
        referenceOnly += 1;
        continue;
      }
      const pending = pendingEntry(entries, unique.headword);
      if (pending.records.length === 0) admitted += 1;
      pending.records.push(unique);
      meanings += unique.senses.length;
    }
  }
  return { entries: admitted, meanings, referenceOnly, byEvidenceId, byTerm };
}

/**
 * Admits secondary canonical meanings. A row must name an exact evidence
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
      // The pinned source may no longer carry the mapped meaning. A deliberate
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
  return { entries: [], examples: [] };
}

/**
 * Accepted enrichment survives a rebuild with its own provenance: generated
 * entries are carried whole, and generated examples on imported meanings are
 * re-attached by their meaning identifier.
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
        generations: db.query<Record<string, unknown>, [string]>(`
          select distinct generation.* from en_generations generation
            join en_senses sense on sense.generation_id = generation.id
           where sense.entry_id = ?
        `).all(entryId)
      };
    });

    const examples = db.query<Record<string, unknown>, []>(`
      select example.* from en_examples example
        join en_senses sense on sense.id = example.sense_id
        join en_entries entry on entry.id = sense.entry_id
       where example.source = 'generated' and entry.source <> 'generated'
       order by example.sense_id, example.position
    `).all();

    return { entries, examples };
  } finally {
    db.close();
  }
}

function restoreRetained(db: Database, retained: Retained): { entries: number; examples: number } {
  let entries = 0;
  let examples = 0;
  db.transaction(() => {
    for (const record of retained.entries) {
      const id = String(record.entry.id);
      if (db.query<{ id: string }, [string]>("select id from en_entries where id = ?").get(id)) continue;
      if (db.query<{ id: string }, [string]>(
        "select id from en_entries where lookup_term = ?"
      ).get(String(record.entry.lookup_term))) continue;
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
    for (const example of retained.examples) {
      const senseId = String(example.sense_id);
      if (!db.query<{ id: string }, [string]>("select id from en_senses where id = ?").get(senseId)) continue;
      // The rebuilt meaning may have gained or lost imported examples, so the
      // retained one is appended rather than dropped onto a taken position.
      const next = db.query<{ position: number }, [string]>(
        "select coalesce(max(position), 0) + 1 as position from en_examples where sense_id = ?"
      ).get(senseId)!.position;
      insertRow(db, "en_examples", { ...example, position: next }, true);
      examples += 1;
    }
  })();
  return { entries, examples };
}

function insertRow(db: Database, table: string, row: Record<string, unknown>, ignore: boolean): void {
  const columns = Object.keys(row);
  db.prepare(
    `insert ${ignore ? "or ignore " : ""}into ${table} (${columns.join(", ")})
     values (${columns.map(() => "?").join(", ")})`
  ).run(...columns.map((column) => row[column] as never));
}

function defaultLicense(source: string): string {
  return source === englishSourcePolicy.primary ? oewnLicense : wiktionaryLicense;
}

function defaultAttribution(source: string): string {
  return source === englishSourcePolicy.primary ? oewnAttribution : wiktionaryAttribution;
}

async function listArchive(path: string): Promise<string[]> {
  if (!path.endsWith(".zip")) throw new Error(`Expected a zipped Open English WordNet archive: ${path}`);
  const listing = await Bun.$`unzip -Z1 ${path}`.text();
  return listing.split("\n").map((name) => name.trim()).filter(Boolean);
}

async function readArchiveJson(path: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.$`unzip -p ${path} ${name}`.text()) as Record<string, unknown>;
}

async function readLines(path: string): Promise<string[]> {
  const text = path.endsWith(".gz")
    ? await new Response(Bun.file(path).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : await Bun.file(path).text();
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) => rm(file, { force: true })));
}
