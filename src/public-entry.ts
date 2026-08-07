import type { ApiLang, PublicLookupItem } from "./types";

export function publicEntryForLanguage(entry: PublicLookupItem, lang: ApiLang): PublicLookupItem {
  if (entry.source !== "generated") return entry;
  return {
    ...entry,
    senses: entry.senses.flatMap((sense) => {
      const glosses = sense.glosses
        .filter((gloss) => !gloss.lang || gloss.lang === lang)
        .map(({ lang: _lang, ...gloss }) => gloss);
      return glosses.length > 0 ? [{ ...sense, glosses }] : [];
    })
  };
}
