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
 * returns the requested language's own ordered sense list or nothing.
 */
export const lookupLanguages: Record<LookupDictionary, ApiLang[]> = {
  ja: ["en", "de", "zh-tw", "zh-cn", "ko"],
  en: ["en", "ja", "zh-tw"]
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
 * One base entry shape for both dictionaries: identity, headwords, senses,
 * glosses, examples, and concise sources. Japanese keeps its readings and
 * inflection details; English keeps its pronunciations.
 */
export type LookupEntry = {
  id: string;
  dictionary: LookupDictionary;
  lang: ApiLang;
  headword: string;
  headwords: LookupHeadword[];
  senses: LookupSense[];
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

export type LookupSense = {
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
 * Returns null when the entry carries no sense in that language, because the
 * contract never substitutes another language's glosses.
 */
export function japaneseLookupEntry(item: PublicLookupItem, lang: ApiLang): LookupEntry | null {
  const senses = item.senses.flatMap<LookupSense>((sense) => {
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
  if (senses.length === 0) return null;
  return {
    id: item.id,
    dictionary: "ja",
    lang,
    headword: item.word,
    headwords: item.headwords,
    senses,
    sources: [item.source === "generated" ? "generated" : `${item.source}:${item.sourceId}`],
    reading: item.reading,
    common: item.common,
    ...(item.estimatedLevel ? { estimatedLevel: item.estimatedLevel } : {}),
    ...(item.inflectionPath ? { inflectionPath: item.inflectionPath } : {})
  };
}

/**
 * Projects a stored English entry into the requested explanation language.
 * Senses carry their own explanation language, so a request for a language
 * the entry does not explain returns nothing rather than a substitute.
 */
export function englishLookupEntry(entry: EnglishEntry, lang: ApiLang): LookupEntry | null {
  const senses = entry.senses
    .filter((sense) => sense.lang === lang)
    .map<LookupSense>((sense) => {
      const {
        lang: _lang,
        glosses,
        examples,
        evidenceIds,
        partOfSpeech,
        provenance,
        source: _source,
        generation: _generation,
        ...rest
      } = sense;
      return {
        ...rest,
        partOfSpeech: [partOfSpeech],
        glosses: glosses.map((gloss) => ({ ...gloss })),
        examples: examples.map((example) => ({
          text: example.text,
          translations: example.translations ?? [],
          source: example.source,
          reviewStatus: example.reviewStatus,
          ...(example.sourceName ? { sourceName: example.sourceName } : {}),
          ...(example.sourceId ? { sourceId: example.sourceId } : {})
        })),
        sources: evidenceIds,
        provenance
      };
    });
  if (senses.length === 0) return null;
  return {
    id: entry.id,
    dictionary: "en",
    lang,
    headword: entry.headword,
    headwords: [{ text: entry.headword }],
    senses,
    sources: entry.sources.map((source) => `${source.source}:${source.sourceEntryId}`),
    pronunciations: entry.pronunciations.map((pronunciation) => ({
      ipa: pronunciation.ipa,
      ...(pronunciation.region ? { region: pronunciation.region } : {})
    }))
  };
}
