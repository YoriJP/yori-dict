export type SourceLang = "eng" | "ger" | string;

export type ApiLang = "en" | "de" | "zh-tw" | "zh-cn" | "ko";

/**
 * Cross-reference to another entry. JMdict-simplified emits one of:
 * [word], [word, senseIndex], [word, reading], [word, reading, senseIndex].
 */
export type Xref = Array<string | number>;

export type JmdictLanguageSource = {
  lang: SourceLang;
  full: boolean;
  wasei: boolean;
  text: string | null;
};

export type JmdictGloss = {
  lang: SourceLang;
  text: string;
  gender?: string | null;
  type?: string | null;
};

export type JmdictKanji = {
  text: string;
  common: boolean;
  tags: string[];
};

export type JmdictKana = {
  text: string;
  common: boolean;
  tags: string[];
  appliesToKanji: string[];
};

export type JmdictSense = {
  partOfSpeech: string[];
  appliesToKanji: string[];
  appliesToKana: string[];
  related?: Xref[];
  antonym?: Xref[];
  field?: string[];
  dialect?: string[];
  misc?: string[];
  info?: string[];
  languageSource?: JmdictLanguageSource[];
  examples?: JmdictExample[];
  gloss: JmdictGloss[];
};

export type JmdictExample = {
  source: { type: string; value: string };
  text: string;
  sentences: Array<{ lang: SourceLang; text: string }>;
};

export type JmdictWord = {
  id: string;
  kanji: JmdictKanji[];
  kana: JmdictKana[];
  sense: JmdictSense[];
};

export type JmdictFile = {
  version?: string;
  languages?: string[];
  dictDate?: string;
  /** Tag code to human-readable description, covering every tag used in senses and forms. */
  tags?: Record<string, string>;
  words: JmdictWord[];
};

export type LookupResponse = {
  item: PublicLookupItem | null;
};

export type BatchLookupResponse = {
  results: BatchLookupResult[];
};

export type BatchLookupResult = {
  input: string;
  item: PublicLookupItem | null;
};

export type PublicLookupItem = {
  id: string;
  word: string;
  reading: string | null;
  common: boolean;
  source: "jmdict" | "generated";
  sourceId: string;
  headwordLanguage: "ja";
  estimatedLevel?: EstimatedLevel;
  inflectionPath?: InflectionStep[];
  headwords: PublicHeadword[];
  senses: PublicSense[];
};

export type PublicEntry = {
  id: string;
  source: "jmdict" | "generated";
  sourceId: string;
  headwordLanguage: "ja";
  estimatedLevel?: EstimatedLevel;
  headwords: PublicHeadword[];
  senses: PublicSense[];
};

export type PublicHeadword = {
  text: string;
  reading: string | null;
  kind: "kanji" | "kana";
  common: boolean;
  tags: string[];
};

/**
 * Sense-level annotations are omitted when empty, so the common case stays small.
 * Tag codes in `misc`, `field`, and `dialect` are described by `tags` on /v1/meta.
 */
export type PublicSense = {
  id: string;
  position: number;
  appliesTo: {
    kanji: string[];
    kana: string[];
  };
  partOfSpeech: string[];
  misc?: string[];
  field?: string[];
  dialect?: string[];
  info?: string[];
  related?: Xref[];
  antonym?: Xref[];
  languageSource?: PublicLanguageSource[];
  examples?: PublicExample[];
  glosses: PublicGloss[];
  evidenceIds?: string[];
  provenance?: "source" | "generated";
  pronunciations?: string[];
  pragmaticFunctions?: string[];
};

export type EstimatedLevel = "N1" | "N2" | "N3" | "N4" | "N5";

export type InflectionStep = {
  from: string;
  to: string;
  reason: string;
};

export type PublicExample = {
  text: string;
  translations: Array<{ lang: string; text: string }>;
  source: "sourced" | "generated";
  sourceName?: string;
  sourceId?: string;
  reviewStatus: "source" | "checked";
};

export type PublicLanguageSource = {
  lang: string;
  full: boolean;
  wasei: boolean;
  text: string | null;
};

export type PublicGloss = {
  text: string;
  source: "jmdict" | "generated";
  reviewStatus: "source" | "checked";
  type?: string;
  lang?: ApiLang;
};
