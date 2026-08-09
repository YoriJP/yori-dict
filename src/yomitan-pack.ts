import { createStoredZip } from "./stored-zip";

/**
 * Yomitan packing, shared by both dictionaries.
 *
 * A pack holds exactly one explanation language. That is enforced here by
 * construction rather than by each release remembering to filter: terms are
 * accumulated into the bank named by the language of the sense they came
 * from, and a pack is written from one language's banks alone.
 */

const termsPerBank = 10_000;

export type LanguageBanks = {
  /**
   * Appends one entry's term rows to its own language's bank. The rows share
   * one sequence number, which is what tells a `sequenced` pack that several
   * written forms are one entry rather than several. Unknown languages are
   * ignored.
   */
  add(lang: string, rows: Array<(sequence: number) => unknown[]>): void;
  languages(): string[];
  banksFor(lang: string): unknown[][][];
};

/** One bank set per explanation language, each numbering its own entries from 1. */
export function createLanguageBanks(languages: readonly string[]): LanguageBanks {
  const banks = new Map<string, unknown[][][]>(languages.map((lang) => [lang, [[]]]));
  const sequence = new Map<string, number>(languages.map((lang) => [lang, 0]));
  return {
    add(lang, rows) {
      const langBanks = banks.get(lang);
      if (!langBanks || rows.length === 0) return;
      const next = (sequence.get(lang) ?? 0) + 1;
      sequence.set(lang, next);
      for (const row of rows) {
        let bank = langBanks.at(-1)!;
        if (bank.length === termsPerBank) {
          bank = [];
          langBanks.push(bank);
        }
        bank.push(row(next));
      }
    },
    languages: () => [...banks.keys()],
    banksFor: (lang) => banks.get(lang) ?? []
  };
}

/**
 * Which JMdict inflection class each part-of-speech tag belongs to.
 *
 * Yomitan validates a deinflection against the term's `rules`: the empty
 * string means the term has no grammatical category, and the conditions check
 * then rejects every inflected candidate while still accepting exact-surface
 * matches. That is why a pack emitting `""` for everything looks like thin
 * coverage rather than a broken pack. Only genuinely non-inflecting entries
 * may carry the empty value.
 *
 * The collapse follows the reference JMdict-to-Yomitan importer: JMdict's
 * dozens of verb classes reduce to the handful of conditions Yomitan's
 * deinflector actually branches on.
 */
function inflectionClass(partOfSpeech: string): string | null {
  if (partOfSpeech.startsWith("v5")) return "v5";
  if (partOfSpeech.startsWith("v1")) return "v1";
  if (partOfSpeech.startsWith("vs-")) return "vs";
  // `adj-ix` is the yoi/ii class, and Yomitan has no separate condition for
  // it: its own rules name いい and よい with `adj-i`, so that is what those
  // entries must carry. No other JMdict adjective tag starts with `adj-i`.
  if (partOfSpeech.startsWith("adj-i")) return "adj-i";
  return ["vk", "vz"].includes(partOfSpeech) ? partOfSpeech : null;
}

/**
 * The `rules` value for one term row, space separated in first-seen order so
 * that a rebuild from identical data produces identical bytes. A term whose
 * parts of speech name no inflecting class gets the empty string, which is the
 * schema's documented meaning for that value.
 */
export function yomitanRules(partsOfSpeech: readonly string[]): string {
  const classes = new Set<string>();
  for (const partOfSpeech of partsOfSpeech) {
    const inflection = inflectionClass(partOfSpeech);
    if (inflection) classes.add(inflection);
  }
  return [...classes].join(" ");
}

/**
 * Yomitan's only intra-dictionary ranking lever, and the reason a pack that
 * leaves it at `0` hands entry order to locale collation.
 *
 * Banded so each signal strictly dominates the next: every common written form
 * outranks every uncommon one, and inside one entry the preferred form
 * outranks its variants. Sense position is deliberately not a band — a row
 * carries a whole language group's glosses in their stored order, so there is
 * no per-sense row left for it to rank.
 */
export function yomitanScore(common: boolean, headwordIndex: number): number {
  return (common ? 1_000_000 : 0) - headwordIndex * 10_000;
}

export type PackIndex = {
  title: string;
  description: string;
  attribution: string;
};

/**
 * Writes one Yomitan v3 pack per explanation language. Each pack carries its
 * own name and description, so two Yori packs can be installed side by side
 * without either one hiding the other.
 */
export async function writeYomitanPacks(
  banks: LanguageBanks,
  options: {
    revision: string;
    path(lang: string): string;
    index(lang: string): PackIndex;
  }
): Promise<void> {
  for (const lang of banks.languages()) {
    const { title, description, attribution } = options.index(lang);
    await Bun.write(options.path(lang), createStoredZip([
      {
        name: "index.json",
        content: JSON.stringify({
          title,
          revision: options.revision,
          format: 3,
          sequenced: true,
          author: "YoriJP",
          url: "https://github.com/YoriJP/yori-dict",
          attribution,
          description
        })
      },
      ...banks.banksFor(lang).map((bank, index) => ({
        name: `term_bank_${index + 1}.json`,
        content: JSON.stringify(bank)
      }))
    ]));
  }
}
