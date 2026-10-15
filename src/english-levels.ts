import { normalizeEnglishLookupTerm } from "./normalize";
import type { CefrLevel } from "./types";

/**
 * A pinned list that rates English headwords on the CEFR scale. CEFR-J covers
 * A1 to B2 and the Octanove profile adds C1 and C2; both ship as
 * `headword,pos,CEFR,...` CSV.
 */
export type EnglishLevelSourceInput = {
  source: "cefr-j" | "octanove";
  version: string;
  file: string;
  sha256?: string;
  url?: string;
  license: string;
  attribution: string;
};

export type EnglishLevel = {
  level: CefrLevel;
  sourceName: string;
  sourceVersion: string;
};

export const cefrLevels: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/**
 * One rating per lookup term from every pinned list. A term rated more than
 * once keeps its easiest band: the lists rate a part of speech or a single
 * sense, while Estimated Level describes the whole entry, and the easiest
 * reading is the one a learner meets first. Keeping the hardest would label
 * `rich` C1 for its culinary sense when CEFR-J places the word at A1.
 */
export function chooseEnglishLevels(
  lists: Array<{ sourceName: string; sourceVersion: string; text: string }>
): Map<string, EnglishLevel> {
  const levels = new Map<string, EnglishLevel>();
  for (const list of lists) {
    for (const { term, level } of parseEnglishLevelList(list.text)) {
      const current = levels.get(term);
      if (current && cefrLevels.indexOf(current.level) <= cefrLevels.indexOf(level)) continue;
      levels.set(term, { level, sourceName: list.sourceName, sourceVersion: list.sourceVersion });
    }
  }
  return levels;
}

/**
 * Reads the headword and band columns. A headword cell may list spelling
 * variants separated by slashes (`color/colour`), and each variant is rated.
 * The part of speech is not used: an entry spans all of them.
 */
export function parseEnglishLevelList(text: string): Array<{ term: string; level: CefrLevel }> {
  const [header, ...lines] = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!header?.startsWith("headword,pos,CEFR")) {
    throw new Error(`Expected a headword,pos,CEFR level list, found: ${header ?? "an empty file"}`);
  }
  return lines.filter((line) => line.trim()).flatMap((line) => {
    // The rated columns are never quoted in the pinned lists; only later
    // free-text columns are, and they are not read.
    const [headword = "", , level = ""] = line.split(",");
    if (!cefrLevels.includes(level as CefrLevel)) throw new Error(`Unknown CEFR band in level list row: ${line}`);
    return headword.split("/")
      .map((variant) => normalizeEnglishLookupTerm(variant))
      .filter(Boolean)
      .map((term) => ({ term, level: level as CefrLevel }));
  });
}
