import type { Database } from "bun:sqlite";
import { readLanguageCoverage, type LanguageCoverage } from "./canonical-store";
import type { ApiLang } from "./types";

export type { LanguageCoverage };

export type ExplanationCoverageGap = {
  entryId: string;
  lang: ApiLang;
  missingEvidenceId: string;
  sourceVersion: string;
  basis: CoverageGapDerivationBasis;
};

export type CoverageGapDerivationBasis =
  | "legacy-exact-sense-mapping"
  | "accepted-authored-evidence";

/** Converts the pre-ja-3 JMdict Sense reference into canonical Evidence identity. */
export function normalizeJapaneseEvidenceId(sourceRef: string): string {
  const legacy = /^yori:s_jmdict_(\d+)_(\d+)$/.exec(sourceRef);
  return legacy ? `jmdict:${legacy[1]}:${legacy[2]}` : sourceRef;
}

export type ExplanationCoverageGapReport = {
  summary: Record<string, { groups: number; missingEvidenceIds: number }>;
  details: ExplanationCoverageGap[];
};

/**
 * Canonical Japanese dictionary tables.
 *
 * One entry owns identity and written forms. Everything that explains the
 * entry — senses, glosses, examples, provenance — hangs off `ja_senses`,
 * which carries the explanation language as data. A gloss or example can
 * therefore only ever belong to the one language its owning sense declares,
 * which is what keeps releases and Yomitan packs from mixing languages.
 */
export const japaneseSchemaVersion = "ja-3";

export const japaneseCanonicalTables = [
  "ja_metadata",
  "ja_entries",
  "ja_forms",
  "ja_lookup_terms",
  "ja_senses",
  "ja_sense_evidence",
  "ja_glosses",
  "ja_examples",
  "ja_generations",
  "ja_explanation_group_gaps"
] as const;

const definitions = `
create table if not exists ja_metadata (
  key text primary key,
  value text not null
);

create table if not exists ja_entries (
  id text primary key,
  source text not null check (source in ('jmdict', 'generated')),
  source_id text not null unique,
  headword_language text not null default 'ja',
  estimated_level text check (estimated_level in ('N1', 'N2', 'N3', 'N4', 'N5'))
);

create table if not exists ja_forms (
  entry_id text not null references ja_entries(id),
  text text not null,
  reading text,
  kind text not null check (kind in ('kanji', 'kana')),
  common integer not null check (common in (0, 1)),
  tags text not null,
  unique (entry_id, text, kind)
);

create table if not exists ja_lookup_terms (
  term text not null,
  entry_id text not null references ja_entries(id),
  match_kind text not null check (match_kind in ('kanji', 'reading')),
  unique (term, entry_id, match_kind)
);

create table if not exists ja_senses (
  id text primary key,
  entry_id text not null references ja_entries(id),
  lang text not null,
  position integer not null,
  applies_to_kanji text not null,
  applies_to_kana text not null,
  part_of_speech text not null,
  misc text not null,
  field text not null,
  dialect text not null,
  info text not null,
  related text not null,
  antonym text not null,
  language_source text not null,
  pronunciations text not null default '[]',
  pragmatic_functions text not null default '[]',
  provenance text not null check (provenance in ('source', 'generated')),
  source_name text,
  source_version text,
  source_ref text,
  generation_id text,
  unique (entry_id, lang, position)
);

create table if not exists ja_glosses (
  sense_id text not null references ja_senses(id),
  position integer not null,
  text text not null,
  source text not null check (source in ('jmdict', 'generated')),
  review_status text not null check (review_status in ('source', 'checked')),
  type text,
  unique (sense_id, position)
);

create table if not exists ja_sense_evidence (
  sense_id text not null references ja_senses(id),
  position integer not null,
  evidence_id text not null,
  source_name text not null,
  unique (sense_id, position),
  unique (sense_id, evidence_id)
);

create table if not exists ja_explanation_group_gaps (
  entry_id text not null references ja_entries(id),
  lang text not null,
  missing_evidence_id text not null,
  source_version text not null,
  basis text not null check (basis in ('legacy-exact-sense-mapping', 'accepted-authored-evidence')),
  primary key (entry_id, lang, missing_evidence_id)
);

create table if not exists ja_examples (
  sense_id text not null references ja_senses(id),
  position integer not null,
  text text not null,
  translations text not null,
  source text not null check (source in ('sourced', 'generated')),
  source_name text,
  source_id text,
  review_status text not null check (review_status in ('source', 'checked')),
  generation_id text,
  check (
    (source = 'sourced' and review_status = 'source') or
    (source = 'generated' and review_status = 'checked')
  ),
  unique (sense_id, position)
);

create table if not exists ja_generations (
  id text primary key,
  model text not null,
  provider text not null,
  reasoning_effort text not null,
  prompt_version text not null,
  service_tier text,
  review_outcome text not null,
  created_at text not null
);

create index if not exists ja_lookup_terms_term_idx on ja_lookup_terms(term);
create index if not exists ja_forms_entry_idx on ja_forms(entry_id);
create index if not exists ja_senses_entry_lang_idx on ja_senses(entry_id, lang, position);
create index if not exists ja_senses_lang_idx on ja_senses(lang);
create index if not exists ja_glosses_sense_idx on ja_glosses(sense_id);
create index if not exists ja_examples_sense_idx on ja_examples(sense_id);
create index if not exists ja_sense_evidence_sense_idx on ja_sense_evidence(sense_id, position);
create index if not exists ja_group_gaps_entry_lang_idx on ja_explanation_group_gaps(entry_id, lang, missing_evidence_id);
`;

export function createJapaneseSchema(db: Database): void {
  db.exec(definitions);
}

/** Every table copied verbatim when one canonical store is grafted onto another. */
export function hasJapaneseSchema(db: Database): boolean {
  return Boolean(
    db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name = 'ja_entries'"
    ).get()
  );
}

/** Exact entry, sense, gloss, and example counts by explanation language. */
export function readCoverage(db: Database): Record<string, LanguageCoverage> {
  return readLanguageCoverage(db, "ja");
}

/** Deterministic evidence-gap audit; non-zero rows are coverage debt, not failure. */
export function readExplanationCoverageGaps(db: Database): ExplanationCoverageGapReport {
  const details = db.query<{
    entry_id: string;
    lang: ApiLang;
    missing_evidence_id: string;
    source_version: string;
    basis: CoverageGapDerivationBasis;
  }, []>(`
    select gap.entry_id, gap.lang, gap.missing_evidence_id, gap.source_version, gap.basis
      from ja_explanation_group_gaps gap
      join ja_senses source_sense
        on source_sense.entry_id = gap.entry_id
       and source_sense.lang = 'en'
       and source_sense.provenance = 'source'
      join ja_sense_evidence source_evidence
        on source_evidence.sense_id = source_sense.id
       and source_evidence.evidence_id = gap.missing_evidence_id
       and source_sense.source_version = gap.source_version
     order by gap.entry_id, gap.lang, source_sense.position, source_evidence.position
  `).all().map((row) => ({
    entryId: row.entry_id,
    lang: row.lang,
    missingEvidenceId: row.missing_evidence_id,
    sourceVersion: row.source_version,
    basis: row.basis
  }));
  const groupsByLang = new Map<string, Set<string>>();
  const missingByLang = new Map<string, number>();
  for (const gap of details) {
    const groups = groupsByLang.get(gap.lang) ?? new Set<string>();
    groups.add(gap.entryId);
    groupsByLang.set(gap.lang, groups);
    missingByLang.set(gap.lang, (missingByLang.get(gap.lang) ?? 0) + 1);
  }
  return {
    summary: Object.fromEntries([...groupsByLang].sort(([left], [right]) => left.localeCompare(right)).map(
      ([lang, groups]) => [lang, { groups: groups.size, missingEvidenceIds: missingByLang.get(lang) ?? 0 }]
    )),
    details
  };
}
