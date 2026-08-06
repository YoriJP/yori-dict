import type {
  EnglishExample,
  EnglishSourceRecord,
  EnglishSourceSense
} from "./english-types";

const oewnLicense = "CC-BY-4.0";
const oewnAttribution = "Open English WordNet contributors";
const wiktionaryLicense = "CC-BY-SA-4.0 AND GFDL-1.1-or-later";
const wiktionaryAttribution = "English Wiktionary contributors; extracted with Wiktextract";

type OewnSynset = {
  definition?: unknown;
  domain_topic?: unknown;
  example?: unknown;
  members?: unknown;
  partOfSpeech?: unknown;
};

export function importOpenEnglishWordNet(
  document: Record<string, unknown>,
  version: string
): EnglishSourceRecord[] {
  const records: EnglishSourceRecord[] = [];
  for (const [synsetId, raw] of Object.entries(document)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const synset = raw as OewnSynset;
    const definitions = stringList(synset.definition);
    const members = stringList(synset.members);
    const partOfSpeech = oewnPartOfSpeech(synset.partOfSpeech);
    if (definitions.length === 0 || members.length === 0 || !partOfSpeech) continue;
    const immutableRaw = raw;
    for (const member of members) {
      const sourceEntryId = `${synsetId}:${member}`;
      const senses = definitions.map((definition, index): EnglishSourceSense => ({
        evidenceId: `open-english-wordnet:${sourceEntryId}:${index + 1}`,
        partOfSpeech,
        definition,
        registers: [],
        regions: [],
        domains: stringList(synset.domain_topic),
        dated: false,
        usage: [],
        examples: stringList(synset.example).map((text, exampleIndex) => ({
          text,
          source: "sourced",
          sourceId: `${synsetId}:example:${exampleIndex + 1}`,
          reviewStatus: "source"
        }))
      }));
      records.push(freezeSourceRecord({
        source: "open-english-wordnet",
        sourceVersion: version,
        sourceEntryId,
        license: oewnLicense,
        attribution: oewnAttribution,
        rawRecord: immutableRaw,
        headword: normalizeMember(member),
        pronunciations: [],
        senses
      }));
    }
  }
  return records;
}

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
  return [freezeSourceRecord({
    source: "wiktionary",
    sourceVersion: version,
    sourceEntryId,
    license: wiktionaryLicense,
    attribution: options.attribution ?? wiktionaryAttribution,
    rawRecord: raw,
    headword: word,
    pronunciations,
    senses
  })];
}

function wiktionarySense(
  raw: unknown,
  partOfSpeech: string,
  sourceEntryId: string,
  index: number
): EnglishSourceSense[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  const definition = stringList(value.glosses)[0];
  if (!definition || stringList(value.tags).includes("form-of")) return [];
  const tags = unique([...stringList(value.tags), ...stringList(value.raw_tags).map((tag) => tag.toLowerCase())]);
  return [{
    evidenceId: `wiktionary:${sourceEntryId}:${index + 1}`,
    partOfSpeech,
    definition,
    registers: tags.flatMap(registerTag),
    regions: tags.flatMap(regionTag),
    domains: unique([...stringList(value.topics), ...tags.flatMap(domainTag)]),
    dated: tags.some((tag) => ["archaic", "dated", "obsolete", "historical"].includes(tag)),
    usage: tags.filter((tag) => ["transitive", "intransitive", "countable", "uncountable", "ergative"].includes(tag)),
    examples: Array.isArray(value.examples) ? value.examples.flatMap(wiktionaryExample) : []
  }];
}

function wiktionaryExample(raw: unknown, index: number): EnglishExample[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const text = nonempty((raw as Record<string, unknown>).text);
  return text ? [{ text, source: "sourced", sourceId: `wiktionary-example:${index + 1}`, reviewStatus: "source" }] : [];
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

function isLexicalHeadword(value: string): boolean {
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

function freezeSourceRecord(record: EnglishSourceRecord): EnglishSourceRecord {
  record.pronunciations.forEach(Object.freeze);
  record.senses.forEach((sense) => {
    sense.examples.forEach(Object.freeze);
    Object.freeze(sense.examples);
    Object.freeze(sense.registers);
    Object.freeze(sense.regions);
    Object.freeze(sense.domains);
    Object.freeze(sense.usage);
    Object.freeze(sense);
  });
  Object.freeze(record.pronunciations);
  Object.freeze(record.senses);
  return Object.freeze(record);
}
