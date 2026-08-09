import type { ApiLang } from "./types";

export type EnglishSourceName = "open-english-wordnet" | "wiktionary";

/**
 * One sense as it is written in a pinned source, addressed by a stable
 * evidence identifier. Records of this shape are import inputs and enrichment
 * evidence; the complete raw source payload never becomes a canonical row.
 */
export type EnglishSourceSense = {
  evidenceId: string;
  /**
   * Concept identifier the source itself gives this sense, when it has one.
   * It is what another source's validated concept mapping can name; it is never
   * used to order senses.
   */
  synset?: string;
  partOfSpeech: string;
  glosses: string[];
  registers: string[];
  regions: string[];
  domains: string[];
  dated: boolean;
  usage: string[];
  examples: EnglishExample[];
};

export type EnglishSourcePronunciation = {
  ipa: string;
  region?: string;
  evidenceId: string;
};

export type EnglishSourceRecord = {
  source: EnglishSourceName;
  sourceVersion: string;
  sourceEntryId: string;
  license: string;
  attribution: string;
  headword: string;
  pronunciations: EnglishSourcePronunciation[];
  senses: EnglishSourceSense[];
};

export type EnglishSourceReference = {
  source: string;
  sourceVersion: string;
  sourceEntryId: string;
  license: string;
  attribution: string;
};

export type EnglishGloss = {
  text: string;
  source: string;
  reviewStatus: "source" | "checked";
  type?: string;
};

export type EnglishExample = {
  text: string;
  /** Empty for an English sense; a later language group carries its own pair. */
  translations?: Array<{ lang: string; text: string }>;
  source: "sourced" | "generated";
  sourceName?: string;
  sourceId?: string;
  reviewStatus: "source" | "checked";
};

export type EnglishPronunciation = {
  ipa: string;
  region?: string;
  source: string;
  sourceRef?: string;
};

/** Concise provenance kept beside canonical generated content. */
export type EnglishGeneration = {
  model: string;
  provider: string;
  reasoningEffort: string;
  promptVersion: string;
  serviceTier?: string;
  reviewOutcome?: string;
  createdAt?: string;
};

/**
 * One entry with the senses of exactly one explanation language. `lang` is
 * stored on every sense, so adding another explanation language for the same
 * English headword adds senses rather than tables or columns.
 */
export type EnglishEntry = {
  id: string;
  dictionary: "en";
  headword: string;
  pronunciations: EnglishPronunciation[];
  senses: EnglishSense[];
  sources: EnglishSourceReference[];
};

export type EnglishSense = {
  id: string;
  lang: ApiLang;
  position: number;
  partOfSpeech: string;
  glosses: EnglishGloss[];
  registers: string[];
  regions: string[];
  domains: string[];
  dated: boolean;
  usage: string[];
  examples: EnglishExample[];
  evidenceIds: string[];
  provenance: "source" | "generated";
  source?: { name: string; version?: string; ref?: string };
  generation?: EnglishGeneration;
};
