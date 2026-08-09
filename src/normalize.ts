export function normalizeQuery(query: string): string {
  return query.trim().normalize("NFKC");
}

/**
 * The one normalization every English lookup term passes through: the storage
 * form, the query form, and the stripper's candidate form are the same string
 * or the lexicon cannot validate a candidate.
 */
export function normalizeEnglishLookupTerm(value: string): string {
  return value.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
