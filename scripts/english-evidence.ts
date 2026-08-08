import { createHash } from "node:crypto";

// Bumping this invalidates previously produced evidence artifacts: a repeat run
// only has to be byte-identical for the same pinned archive and the same tool
// version.
export const evidenceToolVersion = "1.0.0";
export const evidenceToolName = "english-evidence-filter";

export type HttpMetadata = {
  url: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
  contentType: string | null;
  retrievedAt: string;
};

export type ArchiveIdentity = {
  source: string;
  edition: string;
  version: string;
  url: string;
  license: string;
  attribution: string;
  expectedSha256: string | null;
  http: HttpMetadata | null;
};

export type EvidenceCorroboration = {
  source: string;
  version: string;
  detail: string;
};

/**
 * Taiwan support is a claim about one term pair inside one agency's stated
 * domain, so it is keyed by both sides of the pair. A Chinese string alone
 * would let one dataset's term vouch for any English entry whose translation
 * happens to repeat it, which is the generic-Traditional-Chinese relabelling
 * the source policy forbids.
 */
export function taiwanTermPairKey(english: string, chinese: string): string {
  return `${english.trim().toLowerCase()}␟${chinese.trim()}`;
}

export type EvidenceRow = {
  evidenceId: string;
  source: string;
  sourceEdition: string;
  sourceVersion: string;
  sourcePage: string;
  sourcePageId: number | null;
  sourceEntryId: string;
  sourceSenseId: string | null;
  entryOrder: number;
  pos: string;
  scope: "sense-local" | "entry-level";
  senseIndex: number | null;
  sourceMeaning: string | null;
  senseHint: string | null;
  translationLocation: string;
  translationOrder: number;
  targetLanguage: "ja" | "zh";
  targetLocale: string;
  sourceLanguageCode: string;
  sourceLanguageName: string | null;
  targetTerm: string;
  targetRoman: string | null;
  qualifiers: string[];
  taiwanSupport: boolean;
  corroboration: EvidenceCorroboration | null;
  ambiguous: boolean;
  ambiguityReasons: string[];
  role: "authoring-evidence";
  directImportEligible: false;
};

export type LanguageCoverage = {
  senseLocal: number;
  entryLevel: number;
  ambiguous: number;
  corroborated: number;
  unmatched: number;
  rejected: number;
  rejectionsByReason: Record<string, number>;
};

export type EvidenceCoverage = {
  entriesRead: number;
  englishEntries: number;
  entriesWithEvidence: number;
  rowsEmitted: number;
  truncated: boolean;
  ja: LanguageCoverage;
  zh: LanguageCoverage;
};

export type EvidenceManifest = {
  schemaVersion: 1;
  tool: { name: string; version: string };
  upstream: {
    source: string;
    edition: string;
    version: string;
    url: string;
    sha256: string;
    compressedBytes: number;
    license: string;
    attribution: string;
    http: HttpMetadata | null;
  };
  evidence: { file: string; rows: number; sha256: string };
  filter: {
    maxRows: number;
    maxRowsPerEntry: number;
    targetLanguages: string[];
  };
  mappedSources: MappedSourceMeta[];
  coverage: EvidenceCoverage;
};

export type MappedSourceMeta = {
  source: string;
  version: string;
  license: string;
  attribution: string;
  role: string;
  detail?: Record<string, string>;
};

export type CorroborationIndex = {
  japaneseTerms: ReadonlyMap<string, EvidenceCorroboration>;
  taiwanTerms: ReadonlyMap<string, EvidenceCorroboration>;
};

export type FilterOptions = {
  identity: ArchiveIdentity;
  evidenceFileName: string;
  gzip: boolean;
  maxRows: number;
  maxRowsPerEntry: number;
  corroboration?: CorroborationIndex;
  mappedSources?: MappedSourceMeta[];
};

export const emptyCorroborationIndex: CorroborationIndex = {
  japaneseTerms: new Map(),
  taiwanTerms: new Map()
};

const japaneseCodes = new Set(["ja", "jpn", "ja-hira", "ja-kana"]);

// Chinese variants worth keeping as evidence. The raw code stays on every row;
// only the coarse family is used for coverage counting.
const chineseCodes = new Set([
  "zh",
  "cmn",
  "zh-hant",
  "zh-hans",
  "zh-tw",
  "zh-cn",
  "nan",
  "nan-hbl",
  "nan-tw",
  "yue",
  "hak"
]);

const maxLineBytes = 64 * 1024 * 1024;

/**
 * Streams one Wiktextract archive, hashing the compressed bytes as they pass,
 * and emits the filtered Japanese/Chinese evidence rows through `onRow`.
 * Nothing larger than one archive line is ever held in memory.
 */
export async function filterEnglishEvidence(
  body: ReadableStream<Uint8Array>,
  options: FilterOptions,
  onRow: (row: EvidenceRow, line: string) => void | Promise<void>
): Promise<EvidenceManifest> {
  const corroboration = options.corroboration ?? emptyCorroborationIndex;
  const coverage = emptyCoverage();
  const evidenceHash = createHash("sha256");
  const entryOccurrences = new Map<string, number>();

  const archive = await readArchiveLines(body, options.gzip, async (line) => {
    if (!line.trim()) return;
    coverage.entriesRead += 1;
    if (coverage.truncated) return;

    const entry = JSON.parse(line) as WiktextractEntry;
    if (entry.lang_code !== "en" || typeof entry.word !== "string" || !entry.word) return;
    coverage.englishEntries += 1;

    const entryOrder = coverage.englishEntries - 1;
    const identityKey = [entry.word, posOf(entry), etymologyNumberOf(entry)].join("|");
    const occurrence = entryOccurrences.get(identityKey) ?? 0;
    entryOccurrences.set(identityKey, occurrence + 1);

    const rows = evidenceRowsForEntry(entry, {
      identity: options.identity,
      entryOrder,
      occurrence,
      corroboration,
      coverage
    });

    let emittedForEntry = 0;
    let emittedAny = false;
    for (const row of rows) {
      if (emittedForEntry >= options.maxRowsPerEntry) break;
      if (coverage.rowsEmitted >= options.maxRows) {
        coverage.truncated = true;
        break;
      }
      const serialized = `${JSON.stringify(row)}\n`;
      evidenceHash.update(serialized);
      coverage.rowsEmitted += 1;
      emittedForEntry += 1;
      emittedAny = true;
      countAccepted(coverage, row);
      await onRow(row, serialized);
    }
    if (emittedAny) coverage.entriesWithEvidence += 1;
  });

  if (options.identity.expectedSha256 && options.identity.expectedSha256 !== archive.sha256) {
    throw new Error(
      `Upstream archive checksum mismatch: expected ${options.identity.expectedSha256}, got ${archive.sha256}`
    );
  }

  return {
    schemaVersion: 1,
    tool: { name: evidenceToolName, version: evidenceToolVersion },
    upstream: {
      source: options.identity.source,
      edition: options.identity.edition,
      version: options.identity.version,
      url: options.identity.url,
      sha256: archive.sha256,
      compressedBytes: archive.bytes,
      license: options.identity.license,
      attribution: options.identity.attribution,
      http: options.identity.http
    },
    evidence: {
      file: options.evidenceFileName,
      rows: coverage.rowsEmitted,
      sha256: evidenceHash.digest("hex")
    },
    filter: {
      maxRows: options.maxRows,
      maxRowsPerEntry: options.maxRowsPerEntry,
      targetLanguages: ["ja", "zh"]
    },
    mappedSources: options.mappedSources ?? [],
    coverage
  };
}

type WiktextractEntry = {
  word?: unknown;
  pos?: unknown;
  lang?: unknown;
  lang_code?: unknown;
  etymology_number?: unknown;
  pageid?: unknown;
  page_id?: unknown;
  senses?: unknown;
  translations?: unknown;
};

type WiktextractTranslation = {
  code?: unknown;
  lang_code?: unknown;
  lang?: unknown;
  word?: unknown;
  roman?: unknown;
  sense?: unknown;
  tags?: unknown;
  topics?: unknown;
  note?: unknown;
};

type RowContext = {
  identity: ArchiveIdentity;
  entryOrder: number;
  occurrence: number;
  corroboration: CorroborationIndex;
  coverage: EvidenceCoverage;
};

function evidenceRowsForEntry(entry: WiktextractEntry, context: RowContext): EvidenceRow[] {
  const senses = Array.isArray(entry.senses) ? (entry.senses as Record<string, unknown>[]) : [];
  const glosses = senses.map((sense) => glossOf(sense));
  const word = entry.word as string;
  const pos = posOf(entry);
  const sourceEntryId = [
    `${context.identity.source}-${context.identity.edition}`,
    context.identity.version,
    word,
    pos,
    etymologyNumberOf(entry),
    context.occurrence
  ].join(":");

  const rows: EvidenceRow[] = [];

  for (const [senseIndex, sense] of senses.entries()) {
    const translations = Array.isArray(sense.translations) ? (sense.translations as WiktextractTranslation[]) : [];
    for (const [order, translation] of translations.entries()) {
      const row = buildRow(translation, {
        context,
        entry,
        sourceEntryId,
        pos,
        scope: "sense-local",
        senseIndex,
        sourceMeaning: glosses[senseIndex] ?? null,
        sourceSenseId: senseIdOf(sense),
        translationLocation: `senses[${senseIndex}].translations`,
        translationOrder: order,
        senseCount: senses.length,
        glosses
      });
      if (row) rows.push(row);
    }
  }

  const entryTranslations = Array.isArray(entry.translations) ? (entry.translations as WiktextractTranslation[]) : [];
  for (const [order, translation] of entryTranslations.entries()) {
    const hint = typeof translation.sense === "string" && translation.sense.trim() ? translation.sense.trim() : null;
    const matchedIndexes = hint === null ? [] : glosses.flatMap((gloss, index) => (matchesGloss(gloss, hint) ? [index] : []));
    const matchedIndex = matchedIndexes.length === 1 ? matchedIndexes[0]! : null;
    const row = buildRow(translation, {
      context,
      entry,
      sourceEntryId,
      pos,
      scope: "entry-level",
      senseIndex: matchedIndex,
      sourceMeaning: matchedIndex === null ? null : glosses[matchedIndex] ?? null,
      sourceSenseId: matchedIndex === null ? null : senseIdOf(senses[matchedIndex] ?? {}),
      translationLocation: "translations",
      translationOrder: order,
      senseCount: senses.length,
      glosses,
      senseHint: hint
    });
    if (row) rows.push(row);
  }

  return rows;
}

type BuildRowContext = {
  context: RowContext;
  entry: WiktextractEntry;
  sourceEntryId: string;
  pos: string;
  scope: "sense-local" | "entry-level";
  senseIndex: number | null;
  sourceMeaning: string | null;
  sourceSenseId: string | null;
  translationLocation: string;
  translationOrder: number;
  senseCount: number;
  glosses: (string | null)[];
  senseHint?: string | null;
};

function buildRow(translation: WiktextractTranslation, options: BuildRowContext): EvidenceRow | null {
  const code = languageCodeOf(translation);
  if (!code) return null;
  const targetLanguage = targetLanguageOf(code);
  if (!targetLanguage) return null;

  const coverage = options.context.coverage[targetLanguage];
  const term = typeof translation.word === "string" ? translation.word.trim() : "";
  const rejection = rejectionReason(term, targetLanguage);
  if (rejection) {
    coverage.rejected += 1;
    coverage.rejectionsByReason[rejection] = (coverage.rejectionsByReason[rejection] ?? 0) + 1;
    return null;
  }

  const qualifiers = qualifiersOf(translation);
  // Taiwan support requires the dataset's own English/Chinese pair, not a bare
  // Chinese string that any entry's translation might repeat.
  const taiwanMatch = options.context.corroboration.taiwanTerms.get(
    taiwanTermPairKey(String(options.entry.word ?? ""), term)
  ) ?? null;
  const japaneseMatch = options.context.corroboration.japaneseTerms.get(term) ?? null;
  const corroborationMatch = targetLanguage === "ja" ? japaneseMatch : taiwanMatch;
  const ambiguityReasons = ambiguityReasonsFor(term, options);

  return {
    evidenceId: `${options.sourceEntryId}#${options.translationLocation}[${options.translationOrder}]`,
    source: options.context.identity.source,
    sourceEdition: options.context.identity.edition,
    sourceVersion: options.context.identity.version,
    sourcePage: options.entry.word as string,
    sourcePageId: pageIdOf(options.entry),
    sourceEntryId: options.sourceEntryId,
    sourceSenseId: options.sourceSenseId,
    entryOrder: options.context.entryOrder,
    pos: options.pos,
    scope: options.scope,
    senseIndex: options.senseIndex,
    sourceMeaning: options.sourceMeaning,
    senseHint: options.senseHint ?? null,
    translationLocation: options.translationLocation,
    translationOrder: options.translationOrder,
    targetLanguage,
    targetLocale: targetLocaleOf(targetLanguage, code, qualifiers, taiwanMatch !== null),
    sourceLanguageCode: code,
    sourceLanguageName: typeof translation.lang === "string" ? translation.lang : null,
    targetTerm: term,
    targetRoman: typeof translation.roman === "string" && translation.roman.trim() ? translation.roman.trim() : null,
    qualifiers,
    taiwanSupport: targetLanguage === "zh" && taiwanMatch !== null,
    corroboration: corroborationMatch,
    ambiguous: ambiguityReasons.length > 0,
    ambiguityReasons,
    // A translation nested under an English meaning is authoring and review
    // evidence. It never carries its own target-language meaning structure, so
    // it is never eligible for direct import.
    role: "authoring-evidence",
    directImportEligible: false
  };
}

function ambiguityReasonsFor(term: string, options: BuildRowContext): string[] {
  const reasons: string[] = [];
  if (/[,;/、；，]| or /.test(term)) reasons.push("multiple-terms-in-one-record");
  if (options.scope === "entry-level" && options.senseIndex === null && options.senseCount > 1) {
    reasons.push("entry-level-record-cannot-be-attributed-to-one-meaning");
  }
  return reasons;
}

function rejectionReason(term: string, targetLanguage: "ja" | "zh"): string | null {
  if (!term) return "missing-term";
  if (/[\n\r]|^please add|^—$|^-$|^\?+$/i.test(term)) return "malformed-term";
  if (targetLanguage === "ja" && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) {
    return "wrong-script";
  }
  if (targetLanguage === "zh" && !/\p{Script=Han}/u.test(term)) return "wrong-script";
  return null;
}

function targetLanguageOf(code: string): "ja" | "zh" | null {
  if (japaneseCodes.has(code)) return "ja";
  if (chineseCodes.has(code)) return "zh";
  return null;
}

/**
 * Traditional characters alone never establish Taiwanese wording: `zh-tw` is
 * only assigned when Taiwan government terminology corroborates the exact term.
 */
function targetLocaleOf(
  targetLanguage: "ja" | "zh",
  code: string,
  qualifiers: string[],
  taiwanSupported: boolean
): string {
  if (targetLanguage === "ja") return "ja";
  if (taiwanSupported) return "zh-tw";
  const lowered = qualifiers.map((qualifier) => qualifier.toLowerCase());
  // A source's own regional label is recorded in sourceLanguageCode, but the
  // locale we assign stays a script claim until Taiwan terminology supports it.
  if (code === "zh-hant" || code === "zh-tw" || lowered.includes("traditional")) return "zh-hant";
  if (code === "zh-hans" || code === "zh-cn" || lowered.includes("simplified")) return "zh-hans";
  return code === "zh" || code === "cmn" ? "zh" : code;
}

function qualifiersOf(translation: WiktextractTranslation): string[] {
  const values: string[] = [];
  for (const source of [translation.tags, translation.topics]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (typeof item === "string" && item.trim() && !values.includes(item.trim())) values.push(item.trim());
    }
  }
  if (typeof translation.note === "string" && translation.note.trim() && !values.includes(translation.note.trim())) {
    values.push(translation.note.trim());
  }
  return values;
}

function languageCodeOf(translation: WiktextractTranslation): string | null {
  const raw = typeof translation.code === "string" ? translation.code : translation.lang_code;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().toLowerCase();
}

function glossOf(sense: Record<string, unknown>): string | null {
  const glosses = Array.isArray(sense.glosses) ? sense.glosses : null;
  if (!glosses) return null;
  const text = glosses.filter((gloss): gloss is string => typeof gloss === "string").join(" ").trim();
  return text ? text : null;
}

function senseIdOf(sense: Record<string, unknown>): string | null {
  return typeof sense.id === "string" && sense.id.trim() ? sense.id.trim() : null;
}

function matchesGloss(gloss: string | null, hint: string): boolean {
  if (!gloss) return false;
  return normalizeMeaning(gloss) === normalizeMeaning(hint);
}

function normalizeMeaning(value: string): string {
  return value.toLowerCase().replace(/[.\s]+/g, " ").trim();
}

function posOf(entry: WiktextractEntry): string {
  return typeof entry.pos === "string" && entry.pos.trim() ? entry.pos.trim() : "unknown";
}

function etymologyNumberOf(entry: WiktextractEntry): number {
  return typeof entry.etymology_number === "number" ? entry.etymology_number : 0;
}

function pageIdOf(entry: WiktextractEntry): number | null {
  const raw = typeof entry.pageid === "number" ? entry.pageid : entry.page_id;
  return typeof raw === "number" ? raw : null;
}

function countAccepted(coverage: EvidenceCoverage, row: EvidenceRow): void {
  const language = coverage[row.targetLanguage];
  if (row.scope === "sense-local") language.senseLocal += 1;
  else language.entryLevel += 1;
  if (row.ambiguous) language.ambiguous += 1;
  if (row.corroboration) language.corroborated += 1;
  else language.unmatched += 1;
}

function emptyCoverage(): EvidenceCoverage {
  return {
    entriesRead: 0,
    englishEntries: 0,
    entriesWithEvidence: 0,
    rowsEmitted: 0,
    truncated: false,
    ja: emptyLanguageCoverage(),
    zh: emptyLanguageCoverage()
  };
}

function emptyLanguageCoverage(): LanguageCoverage {
  return {
    senseLocal: 0,
    entryLevel: 0,
    ambiguous: 0,
    corroborated: 0,
    unmatched: 0,
    rejected: 0,
    rejectionsByReason: {}
  };
}

/**
 * Reads a possibly gzipped JSONL stream line by line while hashing the raw
 * compressed bytes. The stream is always drained so the checksum covers the
 * complete archive even when filtering stopped early.
 */
export async function readArchiveLines(
  body: ReadableStream<Uint8Array>,
  gzip: boolean,
  onLine: (line: string) => void | Promise<void>
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    }
  });

  const hashed = body.pipeThrough(tap);
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const decoded = gzip ? hashed.pipeThrough(gunzip) : hashed;
  const reader = decoded.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      await onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > maxLineBytes) {
      throw new Error(`Archive line exceeded ${maxLineBytes} bytes; refusing to buffer it`);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) await onLine(buffer);

  return { sha256: hash.digest("hex"), bytes };
}
