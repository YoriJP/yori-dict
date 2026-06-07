export type SourceLang = "eng" | "ger" | string;

export type ApiLang = "en" | "de" | "zh-tw" | "zh-cn" | "ko";

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
  gloss: JmdictGloss[];
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
  words: JmdictWord[];
};

export type MatchType = "exact" | "deinflected";

export type LookupMatch = {
  input: string;
  matchedForm: string;
  matchType: MatchType;
  reasons: string[];
};

export type LookupResponse = {
  query: string;
  normalizedQuery: string;
  requestedLang: ApiLang | null;
  matches: LookupMatch[];
  entries: PublicEntry[];
};

export type PublicEntry = {
  id: string;
  source: "jmdict";
  sourceId: string;
  headwords: PublicHeadword[];
  senses: PublicSense[];
};

export type PublicHeadword = {
  text: string;
  reading: string | null;
  kind: "kanji" | "kana";
  common: boolean;
};

export type PublicSense = {
  id: string;
  position: number;
  partOfSpeech: string[];
  glosses: Record<string, PublicGloss[]>;
};

export type PublicGloss = {
  text: string;
  source: "jmdict";
  reviewStatus: "source";
};
