export type EnglishSourceName = "open-english-wordnet" | "wiktionary";

export type EnglishSourceRecord = {
  source: EnglishSourceName;
  sourceVersion: string;
  sourceEntryId: string;
  license: string;
  attribution: string;
  rawRecord: unknown;
  headword: string;
  pronunciations: EnglishSourcePronunciation[];
  senses: EnglishSourceSense[];
};

export type EnglishSourcePronunciation = {
  ipa: string;
  region?: string;
  evidenceId: string;
};

export type EnglishSourceSense = {
  evidenceId: string;
  partOfSpeech: string;
  definition: string;
  registers: string[];
  regions: string[];
  domains: string[];
  dated: boolean;
  usage: string[];
  examples: EnglishExample[];
};

export type EnglishExample = {
  text: string;
  source: "sourced" | "generated";
  sourceId?: string;
  reviewStatus: "source" | "checked";
};

export type EnglishSourceReference = Pick<
  EnglishSourceRecord,
  "source" | "sourceVersion" | "sourceEntryId" | "license" | "attribution"
>;

export type EnglishEntry = {
  id: string;
  dictionary: "en";
  headword: string;
  pronunciations: Array<{
    ipa: string;
    region?: string;
    evidenceIds: string[];
  }>;
  senses: EnglishSense[];
  sources: EnglishSourceReference[];
};

export type EnglishSense = {
  id: string;
  position: number;
  partOfSpeech: string;
  definition: string;
  registers: string[];
  regions: string[];
  domains: string[];
  dated: boolean;
  usage: string[];
  examples: EnglishExample[];
  evidenceIds: string[];
  provenance: "source" | "generated";
  generation?: {
    model: string;
    provider: string;
    reasoningEffort: "minimal";
    promptVersion: string;
    serviceTier: "flex" | "standard";
  };
};

export type EnglishReleaseManifest = {
  dictionary: "en";
  schemaVersion: 1;
  dictionaryVersion: string;
  createdAt: string;
  counts: { entries: number; senses: number; sourceRecords: number };
  artifacts: {
    sqlite: string;
    jsonl: string;
    yomitan: string;
  };
  sources: Array<{
    source: EnglishSourceName;
    version: string;
    license: string;
    attribution: string;
  }>;
};
