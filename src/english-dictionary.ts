import { createHash } from "node:crypto";
import type {
  EnglishEntry,
  EnglishSense,
  EnglishSourceRecord,
  EnglishSourceReference
} from "./english-types";

export function reconcileEnglishSourceRecords(records: EnglishSourceRecord[]): EnglishEntry[] {
  records.forEach(validateSourceRecord);
  const orderedRecords = [...records].sort((left, right) =>
    `${left.source}:${left.sourceEntryId}`.localeCompare(`${right.source}:${right.sourceEntryId}`, "en")
  );
  const byHeadword = new Map<string, EnglishSourceRecord[]>();
  for (const record of orderedRecords) {
    const headword = normalizeHeadword(record.headword);
    const group = byHeadword.get(headword) ?? [];
    group.push(record);
    byHeadword.set(headword, group);
  }
  return Array.from(byHeadword.entries())
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([lookupTerm, sourceRecords]) => reconcileEntry(
      canonicalDisplayHeadword(lookupTerm, sourceRecords),
      lookupTerm,
      sourceRecords
    ));
}

export function validateEnglishDictionary(entries: EnglishEntry[]): string[] {
  const problems: string[] = [];
  const entryIds = new Set<string>();
  const senseIds = new Set<string>();
  for (const entry of entries) {
    if (entry.dictionary !== "en") problems.push(`${entry.id}: wrong dictionary`);
    if (!entry.headword.trim()) problems.push(`${entry.id}: empty headword`);
    if (!entry.id.startsWith("yori:en:e_")) problems.push(`${entry.id}: invalid entry id`);
    if (entryIds.has(entry.id)) problems.push(`${entry.id}: duplicate entry id`);
    entryIds.add(entry.id);
    if (entry.senses.length === 0) problems.push(`${entry.id}: no senses`);
    const knownEvidence = new Set(entry.sources.map(({ source, sourceEntryId }) => `${source}:${sourceEntryId}:`));
    for (const sense of entry.senses) {
      if (senseIds.has(sense.id)) problems.push(`${sense.id}: duplicate sense id`);
      senseIds.add(sense.id);
      if (!sense.definition.trim()) problems.push(`${sense.id}: empty definition`);
      if (!sense.partOfSpeech.trim()) problems.push(`${sense.id}: empty part of speech`);
      if (sense.provenance === "source" && sense.evidenceIds.length === 0) problems.push(`${sense.id}: source sense has no evidence`);
      if (sense.provenance === "generated" && (sense.evidenceIds.length > 0 || !sense.generation)) {
        problems.push(`${sense.id}: invalid generated provenance`);
      }
      for (const evidenceId of sense.evidenceIds) {
        if (!Array.from(knownEvidence).some((prefix) => evidenceId.startsWith(prefix))) {
          problems.push(`${sense.id}: unknown evidence ${evidenceId}`);
        }
      }
    }
  }
  return problems;
}

function reconcileEntry(headword: string, lookupTerm: string, records: EnglishSourceRecord[]): EnglishEntry {
  const id = stableId("entry", lookupTerm);
  const sources = uniqueBy(
    records.map(sourceReference),
    (source) => `${source.source}:${source.sourceEntryId}`
  ).sort(sourceOrder);
  const pronunciations = uniqueGroups(
    records.flatMap((record) => record.pronunciations),
    (item) => JSON.stringify([item.ipa, item.region ?? ""])
  ).map((group) => ({
    ipa: group[0].ipa,
    ...(group[0].region ? { region: group[0].region } : {}),
    evidenceIds: group.map(({ evidenceId }) => evidenceId).sort()
  }));
  const sourceSenses = records.flatMap((record) => record.senses);
  const senses: EnglishSense[] = uniqueGroups(sourceSenses, senseIdentity).flatMap((group, index) => {
    const sense = group[0];
    return [{
      id: stableId("sense", `${id}:${senseIdentity(sense)}`),
      position: index + 1,
      partOfSpeech: sense.partOfSpeech,
      definition: sense.definition,
      registers: [...sense.registers],
      regions: [...sense.regions],
      domains: [...sense.domains],
      dated: sense.dated,
      usage: [...sense.usage],
      examples: uniqueBy(group.flatMap(({ examples }) => examples), (example) => JSON.stringify(example)),
      evidenceIds: group.map(({ evidenceId }) => evidenceId).sort(),
      provenance: "source"
    }];
  });
  return { id, dictionary: "en", headword, pronunciations, senses, sources };
}

function canonicalDisplayHeadword(lookupTerm: string, records: EnglishSourceRecord[]): string {
  const candidates = records.map(({ headword }) => headword.trim().normalize("NFKC"));
  const lowercase = candidates.find((candidate) => candidate === lookupTerm);
  if (lowercase) return lowercase;
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right, "en"))[0][0];
}

function senseIdentity(sense: EnglishSourceRecord["senses"][number]): string {
  return JSON.stringify([
    normalizeText(sense.definition),
    sense.partOfSpeech,
    [...sense.registers].sort(),
    [...sense.regions].sort(),
    [...sense.domains].sort(),
    sense.dated,
    [...sense.usage].sort()
  ]);
}

function validateSourceRecord(record: EnglishSourceRecord): void {
  if (!record.headword.trim() || !record.sourceEntryId.trim() || !record.sourceVersion.trim()) {
    throw new Error("English source record is missing identity");
  }
  if (!record.license.trim() || !record.attribution.trim()) throw new Error("English source record is missing license metadata");
  if (record.senses.length === 0) throw new Error(`English source record has no senses: ${record.sourceEntryId}`);
  for (const sense of record.senses) {
    if (!sense.evidenceId.startsWith(`${record.source}:${record.sourceEntryId}:`)) {
      throw new Error(`English source evidence does not belong to its record: ${sense.evidenceId}`);
    }
  }
}

function sourceReference(record: EnglishSourceRecord): EnglishSourceReference {
  return {
    source: record.source,
    sourceVersion: record.sourceVersion,
    sourceEntryId: record.sourceEntryId,
    license: record.license,
    attribution: record.attribution
  };
}

function sourceOrder(left: EnglishSourceReference, right: EnglishSourceReference): number {
  return `${left.source}:${left.sourceEntryId}`.localeCompare(`${right.source}:${right.sourceEntryId}`, "en");
}

function normalizeHeadword(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeText(value: string): string {
  return value.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function stableId(kind: "entry" | "sense", identity: string): string {
  const prefix = kind === "entry" ? "e" : "s";
  return `yori:en:${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function uniqueGroups<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const identity = key(item);
    const group = groups.get(identity) ?? [];
    group.push(item);
    groups.set(identity, group);
  }
  return Array.from(groups.values());
}
