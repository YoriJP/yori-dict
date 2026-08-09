import type { ApiLang } from "./types";

/**
 * JMdict source language codes Yori Dict may import from. EDRDG's licence
 * covers only the Japanese and English components; every other translational
 * component is separately copyrighted by its own compilers, so none of them is
 * mapped and their glosses are discarded at import. `DATA_SOURCES.md` records
 * the exclusions. Removing a code here is what removes that source's content
 * from the canonical tables, both release formats, and the Yomitan packs.
 */
const sourceToApiLang: Record<string, ApiLang> = {
  eng: "en",
  "zh-tw": "zh-tw",
  "zh-cn": "zh-cn",
  ko: "ko"
};

/**
 * Explanation languages the API serves. This is deliberately wider than the set
 * of languages any source supplies: a language with no imported content is not
 * an error, it is a gap Enrich-on-Lookup fills. German is exactly that case —
 * its JMdict component is unlicensed, so Yori Dict writes its own German
 * content rather than dropping the language.
 */
const supportedApiLangs = new Set<ApiLang>(["en", "de", "zh-tw", "zh-cn", "ko"]);

export function toApiLang(sourceLang: string): ApiLang | null {
  return sourceToApiLang[sourceLang] ?? null;
}

export function parseApiLang(value: string | null): ApiLang | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return supportedApiLangs.has(normalized as ApiLang) ? (normalized as ApiLang) : null;
}

export const apiLanguages = Array.from(supportedApiLangs);
