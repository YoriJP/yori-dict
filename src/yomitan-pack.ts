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
  /** Appends one term row to its own language's bank. Unknown languages are ignored. */
  add(lang: string, row: (sequence: number) => unknown[]): void;
  languages(): string[];
  banksFor(lang: string): unknown[][][];
};

/** One bank set per explanation language, each numbering its own terms from 1. */
export function createLanguageBanks(languages: readonly string[]): LanguageBanks {
  const banks = new Map<string, unknown[][][]>(languages.map((lang) => [lang, [[]]]));
  const sequence = new Map<string, number>(languages.map((lang) => [lang, 0]));
  return {
    add(lang, row) {
      const langBanks = banks.get(lang);
      if (!langBanks) return;
      let bank = langBanks.at(-1)!;
      if (bank.length === termsPerBank) {
        bank = [];
        langBanks.push(bank);
      }
      const next = (sequence.get(lang) ?? 0) + 1;
      sequence.set(lang, next);
      bank.push(row(next));
    },
    languages: () => [...banks.keys()],
    banksFor: (lang) => banks.get(lang) ?? []
  };
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
