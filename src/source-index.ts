import type { SourceEvidence, TargetDictionary } from "./on-demand-dictionary";

export type SourceEvidenceIndex = {
  lookup(query: string, targetDictionary: TargetDictionary): SourceEvidence[];
};

export async function openSourceEvidenceIndex(paths: string[]): Promise<SourceEvidenceIndex> {
  const byTerm = new Map<string, SourceEvidence[]>();
  const evidenceIds = new Set<string>();
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`Source evidence file does not exist: ${path}`);
    const lines = (await file.text()).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let evidence: SourceEvidence;
      try {
        evidence = validateEvidence(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid source evidence at ${path}:${index + 1}: ${error instanceof Error ? error.message : error}`);
      }
      for (const sense of evidence.senses) {
        if (evidenceIds.has(sense.evidenceId)) throw new Error(`Duplicate source evidence id: ${sense.evidenceId}`);
        evidenceIds.add(sense.evidenceId);
      }
      for (const term of new Set([evidence.headword, ...(evidence.reading ? [evidence.reading] : [])])) {
        const entries = byTerm.get(term) ?? [];
        entries.push(evidence);
        byTerm.set(term, entries);
      }
    }
  }
  return {
    lookup(query, targetDictionary) {
      return targetDictionary === "ja" ? structuredClone(byTerm.get(query) ?? []) : [];
    }
  };
}

function validateEvidence(value: unknown): SourceEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  const candidate = value as Record<string, unknown>;
  if (![candidate.source, candidate.sourceEntryId, candidate.headword].every(nonemptyString)) {
    throw new Error("source, sourceEntryId, and headword are required");
  }
  if (candidate.reading !== undefined && !nonemptyString(candidate.reading)) throw new Error("reading must be a string");
  if (!Array.isArray(candidate.senses) || candidate.senses.length === 0) throw new Error("senses are required");
  for (const sense of candidate.senses) {
    if (!sense || typeof sense !== "object" || Array.isArray(sense)) throw new Error("sense must be an object");
    const row = sense as Record<string, unknown>;
    if (!nonemptyString(row.evidenceId)) throw new Error("evidenceId is required");
    if (!Array.isArray(row.partOfSpeech) || !row.partOfSpeech.every(nonemptyString)) throw new Error("partOfSpeech is invalid");
    if (!Array.isArray(row.glosses) || row.glosses.length === 0) throw new Error("glosses are required");
    for (const gloss of row.glosses) {
      if (!gloss || typeof gloss !== "object" || Array.isArray(gloss)) throw new Error("gloss must be an object");
      const item = gloss as Record<string, unknown>;
      if (!nonemptyString(item.lang) || !nonemptyString(item.text)) throw new Error("gloss language and text are required");
    }
  }
  return value as SourceEvidence;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
