import type { Database } from "bun:sqlite";

/**
 * Canonical English dictionary tables.
 *
 * One entry owns identity, written form, and pronunciations. Everything that
 * explains the entry — meanings, glosses, examples, provenance — hangs off
 * `en_senses`, which carries the explanation language as data. A gloss or
 * example can therefore only ever belong to the one language its owning
 * meaning declares, which is what keeps releases and Yomitan packs from mixing
 * languages. English explanations of English headwords are simply the group
 * whose `lang` is `en`; another explanation language is more rows, not another
 * table.
 */
export const englishSchemaVersion = "en-1";

export const englishCanonicalTables = [
  "en_metadata",
  "en_entries",
  "en_entry_sources",
  "en_pronunciations",
  "en_lookup_terms",
  "en_senses",
  "en_glosses",
  "en_examples",
  "en_generations"
] as const;

const definitions = `
create table if not exists en_metadata (
  key text primary key,
  value text not null
);

create table if not exists en_entries (
  id text primary key,
  source text not null check (source in ('open-english-wordnet', 'wiktionary', 'generated')),
  source_id text not null unique,
  headword text not null,
  lookup_term text not null unique,
  headword_language text not null default 'en'
);

create table if not exists en_entry_sources (
  entry_id text not null references en_entries(id),
  source text not null,
  source_version text not null,
  source_entry_id text not null,
  license text not null,
  attribution text not null,
  unique (entry_id, source, source_entry_id)
);

create table if not exists en_pronunciations (
  entry_id text not null references en_entries(id),
  position integer not null,
  ipa text not null,
  region text,
  source_name text not null,
  source_version text,
  source_ref text,
  unique (entry_id, position)
);

create table if not exists en_lookup_terms (
  term text not null,
  entry_id text not null references en_entries(id),
  unique (term, entry_id)
);

create table if not exists en_senses (
  id text primary key,
  entry_id text not null references en_entries(id),
  lang text not null,
  position integer not null,
  part_of_speech text not null,
  registers text not null default '[]',
  regions text not null default '[]',
  domains text not null default '[]',
  dated integer not null check (dated in (0, 1)),
  usage text not null default '[]',
  provenance text not null check (provenance in ('source', 'generated')),
  source_name text,
  source_version text,
  source_ref text,
  generation_id text,
  unique (entry_id, lang, position)
);

create table if not exists en_glosses (
  sense_id text not null references en_senses(id),
  position integer not null,
  text text not null,
  source text not null,
  review_status text not null check (review_status in ('source', 'checked')),
  type text,
  unique (sense_id, position)
);

create table if not exists en_examples (
  sense_id text not null references en_senses(id),
  position integer not null,
  text text not null,
  translations text not null default '[]',
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

create table if not exists en_generations (
  id text primary key,
  model text not null,
  provider text not null,
  reasoning_effort text not null,
  prompt_version text not null,
  service_tier text,
  review_outcome text not null,
  created_at text not null
);

create index if not exists en_lookup_terms_term_idx on en_lookup_terms(term);
create index if not exists en_entry_sources_entry_idx on en_entry_sources(entry_id);
create index if not exists en_pronunciations_entry_idx on en_pronunciations(entry_id, position);
create index if not exists en_senses_entry_lang_idx on en_senses(entry_id, lang, position);
create index if not exists en_senses_lang_idx on en_senses(lang);
create index if not exists en_glosses_sense_idx on en_glosses(sense_id);
create index if not exists en_examples_sense_idx on en_examples(sense_id);
`;

export function createEnglishSchema(db: Database): void {
  db.exec(definitions);
}

/** Whether this database already carries the canonical English dictionary. */
export function hasEnglishSchema(db: Database): boolean {
  return Boolean(
    db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name = 'en_entries'"
    ).get()
  );
}

export type EnglishLanguageCoverage = {
  entries: number;
  meanings: number;
  glosses: number;
  examples: number;
};

/** Exact entry, meaning, gloss, and example counts by explanation language. */
export function readCoverage(db: Database): Record<string, EnglishLanguageCoverage> {
  const rows = db.query<
    { lang: string; entries: number; meanings: number; glosses: number; examples: number },
    []
  >(`
    select sense.lang as lang,
           count(distinct sense.entry_id) as entries,
           count(distinct sense.id) as meanings,
           (select count(*) from en_glosses g join en_senses s on s.id = g.sense_id where s.lang = sense.lang) as glosses,
           (select count(*) from en_examples e join en_senses s on s.id = e.sense_id where s.lang = sense.lang) as examples
      from en_senses sense
     group by sense.lang
     order by sense.lang
  `).all();
  return Object.fromEntries(rows.map(({ lang, ...counts }) => [lang, counts]));
}
