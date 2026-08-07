import type {
  ApiLang,
  EstimatedLevel,
  InflectionStep,
  PublicLanguageSource,
  PublicLookupItem,
  Xref
} from "./types";
import type { EnglishEntry } from "./english-types";

export type LookupDictionary = "ja" | "en";

/**
 * Every lookup names one headword dictionary and one explanation language.
 * There is no default for either, and no fallback between languages: a lookup
 * returns the requested language's own ordered meaning list or nothing.
 */
const lookupLanguages: Record<LookupDictionary, ApiLang[]> = {
  ja: ["en", "de", "zh-tw", "zh-cn", "ko"],
  en: ["en"]
};

export function parseLookupDictionary(value: unknown): LookupDictionary | null {
  return value === "ja" || value === "en" ? value : null;
}

export function parseLookupLang(dictionary: LookupDictionary, value: unknown): ApiLang | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as ApiLang;
  return lookupLanguages[dictionary].includes(normalized) ? normalized : null;
}

/**
 * One base entry shape for both dictionaries: identity, headwords, meanings,
 * glosses, examples, and concise sources. Japanese keeps its readings and
 * inflection details; English keeps its pronunciations.
 */
export type LookupEntry = {
  id: string;
  dictionary: LookupDictionary;
  lang: ApiLang;
  headword: string;
  headwords: LookupHeadword[];
  meanings: LookupMeaning[];
  sources: string[];
  reading?: string | null;
  common?: boolean;
  estimatedLevel?: EstimatedLevel;
  inflectionPath?: InflectionStep[];
  pronunciations?: LookupPronunciation[];
};

export type LookupHeadword = {
  text: string;
  reading?: string | null;
  kind?: "kanji" | "kana";
  common?: boolean;
  tags?: string[];
};

export type LookupPronunciation = {
  ipa: string;
  region?: string;
};

export type LookupMeaning = {
  id: string;
  position: number;
  partOfSpeech: string[];
  glosses: LookupGloss[];
  examples: LookupExample[];
  sources: string[];
  provenance: "source" | "generated";
  appliesTo?: { kanji: string[]; kana: string[] };
  misc?: string[];
  field?: string[];
  dialect?: string[];
  info?: string[];
  related?: Xref[];
  antonym?: Xref[];
  languageSource?: PublicLanguageSource[];
  pronunciations?: string[];
  pragmaticFunctions?: string[];
  registers?: string[];
  regions?: string[];
  domains?: string[];
  dated?: boolean;
  usage?: string[];
};

export type LookupGloss = {
  text: string;
  source: string;
  reviewStatus: "source" | "checked";
  type?: string;
};

export type LookupExample = {
  text: string;
  translations: Array<{ lang: string; text: string }>;
  source: "sourced" | "generated";
  reviewStatus: "source" | "checked";
  sourceName?: string;
  sourceId?: string;
};

/**
 * Projects a stored Japanese entry into the requested explanation language.
 * Returns null when the entry carries no meaning in that language, because the
 * contract never substitutes another language's glosses.
 */
export function japaneseLookupEntry(item: PublicLookupItem, lang: ApiLang): LookupEntry | null {
  const meanings = item.senses.flatMap<LookupMeaning>((sense) => {
    const glosses = sense.glosses
      .filter((gloss) => !gloss.lang || gloss.lang === lang)
      .map(({ lang: _lang, ...gloss }) => gloss);
    if (glosses.length === 0) return [];
    const { glosses: _glosses, examples, evidenceIds, provenance, ...rest } = sense;
    return [{
      ...rest,
      glosses,
      examples: examples ?? [],
      sources: evidenceIds ?? [],
      provenance: provenance ?? (item.source === "generated" ? "generated" : "source")
    }];
  });
  if (meanings.length === 0) return null;
  return {
    id: item.id,
    dictionary: "ja",
    lang,
    headword: item.word,
    headwords: item.headwords,
    meanings,
    sources: [item.source === "generated" ? "generated" : `${item.source}:${item.sourceId}`],
    reading: item.reading,
    common: item.common,
    ...(item.estimatedLevel ? { estimatedLevel: item.estimatedLevel } : {}),
    ...(item.inflectionPath ? { inflectionPath: item.inflectionPath } : {})
  };
}

/**
 * Projects a stored English entry into the requested explanation language.
 * English content is currently authored in English only, so any other
 * requested language has no content rather than a translated substitute.
 */
export function englishLookupEntry(entry: EnglishEntry, lang: ApiLang): LookupEntry | null {
  if (lang !== "en") return null;
  const meanings = entry.senses.map<LookupMeaning>((sense) => {
    const { definition, examples, evidenceIds, partOfSpeech, provenance, generation: _generation, ...rest } = sense;
    return {
      ...rest,
      partOfSpeech: [partOfSpeech],
      glosses: [{
        text: definition,
        source: provenance === "generated" ? "generated" : sourceName(evidenceIds) ?? "source",
        reviewStatus: provenance === "generated" ? "checked" : "source"
      }],
      examples: examples.map((example) => ({
        text: example.text,
        translations: [],
        source: example.source,
        reviewStatus: example.reviewStatus,
        ...(example.sourceId ? { sourceId: example.sourceId } : {})
      })),
      sources: evidenceIds,
      provenance
    };
  });
  if (meanings.length === 0) return null;
  return {
    id: entry.id,
    dictionary: "en",
    lang,
    headword: entry.headword,
    headwords: [{ text: entry.headword }],
    meanings,
    sources: entry.sources.map((source) => `${source.source}:${source.sourceEntryId}`),
    pronunciations: entry.pronunciations.map((pronunciation) => ({
      ipa: pronunciation.ipa,
      ...(pronunciation.region ? { region: pronunciation.region } : {})
    }))
  };
}

function sourceName(evidenceIds: string[]): string | null {
  const [evidenceId] = evidenceIds;
  return evidenceId ? evidenceId.split(":")[0] : null;
}
