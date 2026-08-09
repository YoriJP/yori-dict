import type {
  EnglishExample,
  EnglishSourceRecord,
  EnglishSourceSense
} from "./english-types";

export const oewnLicense = "CC-BY-4.0";
export const oewnAttribution = "Open English WordNet contributors";
export const wiktionaryLicense = "CC-BY-SA-4.0 AND GFDL-1.1-or-later";
export const wiktionaryAttribution =
  "Simple English Wiktionary contributors; extracted with Wiktextract";

/**
 * Display name and home for each pinned source. A credit a consumer inherits
 * has to be actionable, and neither the internal source identifier nor a
 * repository-relative file path is a name a reader recognises or a place they
 * can go. A source missing from this table publishes no `/v1/meta` credit,
 * which is the visible symptom of admitting a source without recording where
 * it came from.
 */
export const englishSourceCredits: Record<string, { name: string; url: string }> = {
  "open-english-wordnet": { name: "Open English WordNet", url: "https://en-word.net/" },
  wiktionary: {
    name: "Simple English Wiktionary",
    url: "https://simple.wiktionary.org/wiki/Wiktionary:Copyrights"
  },
  "japanese-wordnet": { name: "Japanese WordNet", url: "https://bond-lab.github.io/wnja/" },
  "taiwan-terminology": { name: "Taiwan government terminology", url: "https://terms.naer.edu.tw/" }
};

/** One synset as the pinned Open English WordNet JSON export writes it. */
export type OewnSynset = {
  definition?: unknown;
  domain_topic?: unknown;
  example?: unknown;
  members?: unknown;
  partOfSpeech?: unknown;
};

/** One lexical entry: part-of-speech blocks, each with its own ordered senses. */
export type OewnLexicalEntry = Record<string, {
  sense?: unknown;
  pronunciation?: unknown;
  form?: unknown;
}>;

export type OewnEntryRecord = EnglishSourceRecord & {
  source: "open-english-wordnet";
  /** Alternate written forms the source lists for this entry. */
  forms: string[];
};

/**
 * Reads one Open English WordNet lexical entry into source records that keep
 * the archive's own editorial order: one record per part-of-speech block, and
 * one sense per element of that block's `sense` array, in array order. The
 * synset identifier is only ever used to look a definition up — never to sort.
 */
export function importOpenEnglishWordNetEntry(
  headword: string,
  entry: OewnLexicalEntry,
  synsets: (id: string) => OewnSynset | undefined,
  version: string
): OewnEntryRecord[] {
  const records: OewnEntryRecord[] = [];
  for (const [posKey, block] of Object.entries(entry)) {
    if (!block || typeof block !== "object") continue;
    const partOfSpeech = oewnPartOfSpeech(posKey.split("-")[0]);
    const senseList = Array.isArray(block.sense) ? block.sense : [];
    if (!partOfSpeech || senseList.length === 0) continue;
    const sourceEntryId = `${headword}:${posKey}`;

    const senses = senseList.flatMap((raw): EnglishSourceSense[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const sense = raw as { id?: unknown; synset?: unknown };
      const senseId = nonempty(sense.id);
      const synsetId = nonempty(sense.synset);
      if (!senseId || !synsetId) return [];
      const synset = synsets(synsetId);
      const glosses = stringList(synset?.definition);
      if (glosses.length === 0) return [];
      return [{
        evidenceId: `open-english-wordnet:${senseId}`,
        synset: synsetId,
        partOfSpeech,
        glosses,
        registers: [],
        regions: [],
        domains: stringList(synset?.domain_topic).flatMap((topic) => {
          const label = stringList(synsets(topic)?.members)[0];
          return label ? [normalizeMember(label)] : [];
        }),
        dated: false,
        usage: [],
        // A synset example belongs to exactly the sense that names the
        // synset, so it is an exactly mapped imported example.
        examples: stringList(synset?.example).map((text, index): EnglishExample => ({
          text,
          source: "sourced",
          sourceName: "open-english-wordnet",
          sourceId: `${synsetId}:example:${index + 1}`,
          reviewStatus: "source"
        }))
      }];
    });
    if (senses.length === 0) continue;

    records.push({
      source: "open-english-wordnet",
      sourceVersion: version,
      sourceEntryId,
      license: oewnLicense,
      attribution: oewnAttribution,
      headword: normalizeMember(headword),
      forms: stringList(block.form).map(normalizeMember),
      pronunciations: pronunciationList(block.pronunciation).map((item, index) => ({
        ipa: item.ipa,
        ...(item.region ? { region: item.region } : {}),
        evidenceId: `open-english-wordnet:${sourceEntryId}:pronunciation:${index + 1}`
      })),
      senses
    });
  }
  return records;
}

/**
 * Reads one Simple English Wiktionary extract record. Simple Wiktionary is the
 * fallback and reference source, so these records only become canonical for a
 * headword Open English WordNet does not cover, or through an explicit mapping.
 */
export function importWiktionaryEntry(
  raw: unknown,
  version: string,
  options: { attribution?: string; recordIdSuffix?: string } = {}
): EnglishSourceRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  const word = nonempty(value.word);
  const language = nonempty(value.lang_code);
  const partOfSpeech = wiktionaryPartOfSpeech(value.pos);
  if (language !== "en" || !word || !partOfSpeech || !isLexicalHeadword(word)) return [];
  const etymology = typeof value.etymology_number === "number" ? value.etymology_number : 1;
  const sourceEntryId = `en:${word}:${partOfSpeech}:${etymology}${options.recordIdSuffix ? `:${options.recordIdSuffix}` : ""}`;
  const senses = Array.isArray(value.senses)
    ? value.senses.flatMap((sense, index) => wiktionarySense(sense, partOfSpeech, sourceEntryId, index))
    : [];
  if (senses.length === 0) return [];
  const pronunciations = Array.isArray(value.sounds)
    ? value.sounds.flatMap((sound, index) => {
        if (!sound || typeof sound !== "object" || Array.isArray(sound)) return [];
        const item = sound as Record<string, unknown>;
        const ipa = nonempty(item.ipa);
        if (!ipa) return [];
        const region = regionFromTags(stringList(item.tags));
        return [{
          ipa,
          ...(region ? { region } : {}),
          evidenceId: `wiktionary:${sourceEntryId}:pronunciation:${index + 1}`
        }];
      })
    : [];
  return [{
    source: "wiktionary",
    sourceVersion: version,
    sourceEntryId,
    license: wiktionaryLicense,
    attribution: options.attribution ?? wiktionaryAttribution,
    headword: word,
    pronunciations,
    senses
  }];
}

/**
 * Sense categories by which Simple English Wiktionary declares a page to be an
 * inflected form rather than a lexeme. Only inflection is listed: comparatives
 * and plurals are forms of a word, while "Countable nouns" or "Slang" describe
 * a real sense and must not be dropped.
 *
 * A page carrying both a form sense and a genuine one — `glasses` is the
 * plural of `glass` and also a word for spectacles — keeps the genuine sense,
 * because the drop is per sense rather than per page.
 */
const inflectedFormCategories = new Set([
  "Plurals",
  "Past tense forms",
  "Past participles",
  "Present participles",
  "Third-person singular forms",
  "Comparative forms",
  "Superlative forms"
]);

const inflection = "(?:plural|past tense|past participle|present participle|third[- ]person singular|comparative|superlative)";

/**
 * A gloss that only states an inflectional relationship: "plural of bank",
 * "The plural form of banner", "Chihuahuas is the plural of chihuahua".
 *
 * This is the backstop for a form page whose sense the editors never
 * categorised, which is the only way one still reaches import. It reads the
 * source's own sentence about itself rather than guessing from the headword,
 * so it cannot mistake a lexeme for a form: `his` glosses "belonging to him"
 * and `fyi` glosses "a short way of saying for your information", and neither
 * is a statement about inflection.
 */
const inflectionStatement = new RegExp(
  "^(?:"
  + `(?:the\\s+)?(?:alternative\\s+|present\\s+)?${inflection}(?:\\s+form)?\\s+of\\s+\\S`
  + "|more than one\\s+\\S"
  + `|\\S+\\s+is\\s+(?:an?\\s+|the\\s+)?(?:alternative\\s+|present\\s+)?${inflection}(?:\\s+form)?\\s+of\\s+\\S`
  + ")",
  "i"
);

/**
 * Whether a gloss says nothing but which form of another word this is. Every
 * clause must, so "The plural form of glass; more than one glass" is a form
 * while a sense that merely mentions a plural in passing is not.
 */
function statesOnlyInflection(gloss: string): boolean {
  const clauses = gloss.replace(/\.+$/, "").split(";").map((clause) => clause.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => inflectionStatement.test(clause));
}

function wiktionarySense(
  raw: unknown,
  partOfSpeech: string,
  sourceEntryId: string,
  index: number
): EnglishSourceSense[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  const glosses = stringList(value.glosses);
  if (glosses.length === 0 || stringList(value.tags).includes("form-of")) return [];
  // The wiki has one page per orthographic string, so a word form gets a page
  // and a definition of its own: "The plural form of child; more than one
  // (kind of) child." That is a form, not a lexeme, and publishing it dead-ends
  // the reader who looked it up. The source says so itself by categorising the
  // sense, which is how the irregular forms the stripper cannot reach —
  // `children`, `geese`, `mice`, `went` — are caught by the same rule as the
  // regular ones rather than by an exception list.
  if (stringList(value.categories).some((category) => inflectedFormCategories.has(category))) return [];
  // Categorisation is the source's reliable signal, but a few thousand form
  // pages were never categorised, and one that reaches lookup is worse than a
  // miss: an entry exists, so enrich-on-lookup never runs and the reader is
  // left with "the plural form of banner" for good. Dropped, the surface
  // strips to `banner` and answers with the real senses.
  if (glosses.every(statesOnlyInflection)) return [];
  const tags = unique([...stringList(value.tags), ...stringList(value.raw_tags).map((tag) => tag.toLowerCase())]);
  return [{
    evidenceId: `wiktionary:${sourceEntryId}:${index + 1}`,
    partOfSpeech,
    glosses: glosses.slice(0, 1),
    registers: tags.flatMap(registerTag),
    regions: tags.flatMap(regionTag),
    domains: unique([...stringList(value.topics), ...tags.flatMap(domainTag)]),
    dated: tags.some((tag) => ["archaic", "dated", "obsolete", "historical"].includes(tag)),
    usage: tags.filter((tag) => ["transitive", "intransitive", "countable", "uncountable", "ergative"].includes(tag)),
    examples: Array.isArray(value.examples)
      ? value.examples.flatMap((example, exampleIndex) =>
          wiktionaryExample(example, sourceEntryId, index, exampleIndex))
      : []
  }];
}

function wiktionaryExample(
  raw: unknown,
  sourceEntryId: string,
  senseIndex: number,
  index: number
): EnglishExample[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const text = nonempty((raw as Record<string, unknown>).text);
  return text
    ? [{
        text,
        source: "sourced",
        sourceName: "wiktionary",
        sourceId: `${sourceEntryId}:${senseIndex + 1}:example:${index + 1}`,
        reviewStatus: "source"
      }]
    : [];
}

function pronunciationList(value: unknown): Array<{ ipa: string; region?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const ipa = nonempty(item.value);
    if (!ipa) return [];
    const region = nonempty(item.variety);
    return [{ ipa, ...(region ? { region } : {}) }];
  });
}

function oewnPartOfSpeech(value: unknown): string | null {
  const code = nonempty(value);
  return code ? ({ n: "noun", v: "verb", a: "adjective", s: "adjective", r: "adverb" }[code] ?? null) : null;
}

function wiktionaryPartOfSpeech(value: unknown): string | null {
  const partOfSpeech = nonempty(value)?.toLowerCase();
  if (!partOfSpeech || ["name", "proper noun", "proper-noun", "character", "punctuation", "symbol"].includes(partOfSpeech)) return null;
  return ({ adj: "adjective", adv: "adverb", prep: "preposition", pron: "pronoun" } as Record<string, string>)[partOfSpeech]
    ?? partOfSpeech;
}

function registerTag(tag: string): string[] {
  if (tag === "figuratively") return ["figurative"];
  return ["formal", "informal", "colloquial", "slang", "vulgar", "humorous", "literary"].includes(tag) ? [tag] : [];
}

function regionTag(tag: string): string[] {
  const region = regionFromTags([tag]);
  return region ? [region] : [];
}

function domainTag(tag: string): string[] {
  return ["sports", "medicine", "law", "computing", "finance", "linguistics", "chemistry", "physics"].includes(tag)
    ? [tag]
    : [];
}

function regionFromTags(tags: string[]): string | undefined {
  for (const tag of tags) {
    const region = ({
      "General-American": "US",
      American: "US",
      US: "US",
      British: "UK",
      UK: "UK",
      Australian: "AU",
      Canadian: "CA",
      Ireland: "IE",
      Irish: "IE"
    } as Record<string, string>)[tag];
    if (region) return region;
  }
  return undefined;
}

export function isLexicalHeadword(value: string): boolean {
  return Array.from(value).length <= 80
    && !/[\n\r\p{Cc}]|<[^>]+>|https?:\/\/|www\./iu.test(value)
    && /\p{Letter}/u.test(value)
    && !/^\p{Number}+[\p{Number}\p{Punctuation}\s]*$/u.test(value);
}

function normalizeMember(value: string): string {
  return value.replaceAll("_", " ");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
