import { taiwanTermPairKey } from "./english-evidence";
import type { EvidenceCorroboration, MappedSourceMeta } from "./english-evidence";

/**
 * Source policy for the English multilingual evidence pipeline.
 *
 * Direct import means a source record may become canonical target-language
 * dictionary content. It requires the source's own target-language sense
 * structure, the correct locale, redistribution rights, and complete
 * provenance. Everything else stays supporting or authoring evidence.
 */
export type SourceRole = "direct-import-candidate" | "supporting-evidence" | "authoring-evidence" | "restricted";

/**
 * Reverse dictionaries and Simplified Chinese resources describe a target-side
 * headword, not a target-language sense of an English headword. They may
 * corroborate evidence but never become canonical on a string or reverse-gloss
 * match alone.
 */
export const supportingOnlySourceIds = [
  "jmdict-reverse",
  "cc-cedict",
  "chinese-wordnet-simplified",
  "wiktionary-en-translations"
] as const;

/** Sources that need a separately documented permission grant before any import. */
export const restrictedSourceIds = ["ntu-chinese-wordnet"] as const;

export type PermissionGrant = {
  document: string;
  grantedAt: string;
  grantedBy: string;
};

export type DirectImportCandidate = {
  sourceId: string;
  sourceVersion: string;
  recordId: string;
  /** Locale the import would publish into, such as `ja` or `zh-tw`. */
  targetLocale: string;
  /** Locale the source record itself declares. */
  recordLocale: string;
  /** True when the record carries its own sense text in the target language. */
  hasTargetLanguageSenseStructure: boolean;
  matchedBy: "source-identifier" | "explicit-mapping" | "string-match" | "reverse-gloss" | "none";
  license: string | null;
  attribution: string | null;
  permissionGrant?: PermissionGrant | null;
};

export type SourceClassification = {
  role: SourceRole;
  eligible: boolean;
  reasons: string[];
};

export function classifySourceRecord(candidate: DirectImportCandidate): SourceClassification {
  const reasons: string[] = [];
  const restricted = (restrictedSourceIds as readonly string[]).includes(candidate.sourceId);
  if (restricted && !candidate.permissionGrant) {
    return {
      role: "restricted",
      eligible: false,
      reasons: ["restricted-source-requires-a-documented-permission-grant"]
    };
  }

  if ((supportingOnlySourceIds as readonly string[]).includes(candidate.sourceId)) {
    reasons.push("source-is-supporting-evidence-only");
  }
  if (candidate.matchedBy === "string-match" || candidate.matchedBy === "reverse-gloss" || candidate.matchedBy === "none") {
    reasons.push("match-is-not-an-exact-source-identifier-or-explicit-mapping");
  }
  if (!candidate.hasTargetLanguageSenseStructure) {
    reasons.push("source-has-no-target-language-sense-structure");
  }
  if (candidate.recordLocale !== candidate.targetLocale) {
    reasons.push("record-locale-does-not-match-the-target-locale");
  }
  if (!candidate.license) reasons.push("no-recorded-redistribution-license");
  if (!candidate.attribution) reasons.push("no-recorded-attribution");
  if (!candidate.sourceVersion || !candidate.recordId) reasons.push("incomplete-provenance");

  if (reasons.length > 0) {
    return { role: "supporting-evidence", eligible: false, reasons };
  }
  return { role: "direct-import-candidate", eligible: true, reasons: [] };
}

/** Throws unless a candidate may legally and structurally be imported. */
export function assertImportable(candidate: DirectImportCandidate): void {
  const classification = classifySourceRecord(candidate);
  if (classification.eligible) return;
  throw new Error(
    `${candidate.sourceId} record ${candidate.recordId} is not direct-import eligible: ${classification.reasons.join(", ")}`
  );
}

// --- Japanese WordNet ------------------------------------------------------

export type JapaneseWordNetRecord = {
  synset: string;
  lemma: string;
  lang: string;
  definition?: string | null;
};

export type IliMapping = {
  synset: string;
  ili: string;
  pwnSynset: string;
  validated: boolean;
};

export type JapaneseWordNetMeta = {
  version: string;
  license: string;
  attribution: string;
  mappingSource: string;
  mappingVersion: string;
};

export type JapaneseWordNetEvidence = {
  evidenceId: string;
  source: "japanese-wordnet";
  sourceVersion: string;
  synset: string;
  lemma: string;
  definition: string | null;
  targetLocale: "ja";
  mapping: { ili: string; pwnSynset: string; mappingSource: string; mappingVersion: string; validated: true };
  role: SourceRole;
  reasons: string[];
};

export type MappedImport<T> = {
  accepted: T[];
  rejected: Array<{ recordId: string; reason: string }>;
  meta: MappedSourceMeta;
};

/**
 * Japanese WordNet evidence enters only through a validated Princeton
 * WordNet/ILI mapping, and every accepted row keeps that mapping's provenance
 * and version.
 */
export function importJapaneseWordNetEvidence(
  records: readonly JapaneseWordNetRecord[],
  mappings: readonly IliMapping[],
  meta: JapaneseWordNetMeta
): MappedImport<JapaneseWordNetEvidence> {
  const bySynset = new Map(mappings.map((mapping) => [mapping.synset, mapping]));
  const accepted: JapaneseWordNetEvidence[] = [];
  const rejected: Array<{ recordId: string; reason: string }> = [];

  for (const record of records) {
    const recordId = `${record.synset}:${record.lemma}`;
    if (record.lang !== "jpn") {
      rejected.push({ recordId, reason: "record-is-not-japanese" });
      continue;
    }
    const mapping = bySynset.get(record.synset);
    if (!mapping) {
      rejected.push({ recordId, reason: "no-princeton-wordnet-ili-mapping" });
      continue;
    }
    if (!mapping.validated) {
      rejected.push({ recordId, reason: "princeton-wordnet-ili-mapping-is-not-validated" });
      continue;
    }

    const definition = record.definition?.trim() ? record.definition.trim() : null;
    const classification = classifySourceRecord({
      sourceId: "japanese-wordnet",
      sourceVersion: meta.version,
      recordId,
      targetLocale: "ja",
      recordLocale: "ja",
      hasTargetLanguageSenseStructure: definition !== null,
      matchedBy: "explicit-mapping",
      license: meta.license,
      attribution: meta.attribution
    });

    accepted.push({
      evidenceId: `japanese-wordnet:${meta.version}:${recordId}`,
      source: "japanese-wordnet",
      sourceVersion: meta.version,
      synset: record.synset,
      lemma: record.lemma,
      definition,
      targetLocale: "ja",
      mapping: {
        ili: mapping.ili,
        pwnSynset: mapping.pwnSynset,
        mappingSource: meta.mappingSource,
        mappingVersion: meta.mappingVersion,
        validated: true
      },
      role: classification.role,
      reasons: classification.reasons
    });
  }

  return {
    accepted,
    rejected,
    meta: {
      source: "japanese-wordnet",
      version: meta.version,
      license: meta.license,
      attribution: meta.attribution,
      role: "mapped-reference",
      detail: { mappingSource: meta.mappingSource, mappingVersion: meta.mappingVersion }
    }
  };
}

// --- Taiwan government terminology -----------------------------------------

export type TaiwanTerminologyRecord = {
  recordId: string;
  agency: string;
  dataset: string;
  domain: string;
  version: string;
  attribution: string;
  license?: string | null;
  english: string;
  chinese: string;
  definition?: string | null;
};

export type TaiwanTerminologyEvidence = {
  evidenceId: string;
  source: "taiwan-terminology";
  agency: string;
  dataset: string;
  domain: string;
  version: string;
  attribution: string;
  termPair: { english: string; chinese: string };
  definition: string | null;
  targetLocale: "zh-tw";
  domainSpecific: true;
  role: SourceRole;
  reasons: string[];
};

const requiredTaiwanFields = ["agency", "dataset", "domain", "version", "attribution", "english", "chinese"] as const;

/**
 * Taiwan government terminology is authoritative only inside its stated domain,
 * so every row keeps its agency, dataset, domain, version, attribution, and the
 * exact English/Chinese term pair.
 */
export function importTaiwanTerminology(
  records: readonly TaiwanTerminologyRecord[],
  options: { license: string }
): MappedImport<TaiwanTerminologyEvidence> {
  const accepted: TaiwanTerminologyEvidence[] = [];
  const rejected: Array<{ recordId: string; reason: string }> = [];

  for (const record of records) {
    const missing = requiredTaiwanFields.filter((field) => !String(record[field] ?? "").trim());
    if (missing.length > 0) {
      rejected.push({ recordId: record.recordId || "(unidentified)", reason: `incomplete-provenance:${missing.join("+")}` });
      continue;
    }

    const definition = record.definition?.trim() ? record.definition.trim() : null;
    const classification = classifySourceRecord({
      sourceId: "taiwan-terminology",
      sourceVersion: record.version,
      recordId: record.recordId,
      targetLocale: "zh-tw",
      recordLocale: "zh-tw",
      // A bare term pair is domain evidence. Only a record carrying its own
      // Taiwanese sense text may be a direct-import candidate.
      hasTargetLanguageSenseStructure: definition !== null,
      matchedBy: "source-identifier",
      license: record.license ?? options.license,
      attribution: record.attribution
    });

    accepted.push({
      evidenceId: `taiwan-terminology:${record.dataset}:${record.version}:${record.recordId}`,
      source: "taiwan-terminology",
      agency: record.agency,
      dataset: record.dataset,
      domain: record.domain,
      version: record.version,
      attribution: record.attribution,
      termPair: { english: record.english, chinese: record.chinese },
      definition,
      targetLocale: "zh-tw",
      domainSpecific: true,
      role: classification.role,
      reasons: classification.reasons
    });
  }

  const datasets = Array.from(new Set(accepted.map((row) => row.dataset))).sort();
  const versions = Array.from(new Set(accepted.map((row) => row.version))).sort();
  return {
    accepted,
    rejected,
    meta: {
      source: "taiwan-terminology",
      version: versions.join(","),
      license: options.license,
      attribution: Array.from(new Set(accepted.map((row) => row.attribution))).sort().join("; "),
      role: "domain-specific-evidence",
      detail: {
        datasets: datasets.join(","),
        agencies: Array.from(new Set(accepted.map((row) => row.agency))).sort().join(","),
        domains: Array.from(new Set(accepted.map((row) => row.domain))).sort().join(",")
      }
    }
  };
}

// --- Corroboration indexes --------------------------------------------------

export function taiwanCorroborationIndex(
  evidence: readonly TaiwanTerminologyEvidence[]
): Map<string, EvidenceCorroboration> {
  const index = new Map<string, EvidenceCorroboration>();
  for (const row of evidence) {
    const key = taiwanTermPairKey(row.termPair.english, row.termPair.chinese);
    if (index.has(key)) continue;
    index.set(key, {
      source: "taiwan-terminology",
      version: row.version,
      detail: `${row.agency}/${row.dataset}/${row.domain}`
    });
  }
  return index;
}

export function japaneseWordNetCorroborationIndex(
  evidence: readonly JapaneseWordNetEvidence[]
): Map<string, EvidenceCorroboration> {
  const index = new Map<string, EvidenceCorroboration>();
  for (const row of evidence) {
    if (index.has(row.lemma)) continue;
    index.set(row.lemma, {
      source: "japanese-wordnet",
      version: row.sourceVersion,
      detail: `${row.mapping.pwnSynset}/${row.mapping.ili}`
    });
  }
  return index;
}
