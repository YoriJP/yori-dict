import type { ApiLang } from "../src/types";

export type AiGlossSource = {
  senseId: string;
  lang: ApiLang;
  glosses: string[];
  source: "ai-assisted";
  model: string;
};

export type GlossValidationInput = {
  glosses: string[];
  lang: ApiLang;
  sourceGlosses?: string[];
  maxGlosses: number;
  maxGlossLength: number;
};

export function normalizeGlosses(glosses: string[]): string[] {
  return glosses.map((gloss) => gloss.trim().replaceAll("...", "……")).filter(Boolean);
}

export function validateGlosses(input: GlossValidationInput): string[] {
  const reasons: string[] = [];
  const glosses = normalizeGlosses(input.glosses);

  if (glosses.length === 0) {
    reasons.push("no glosses");
  }
  if (glosses.length > input.maxGlosses) {
    reasons.push(`too many glosses: ${glosses.length}`);
  }
  if (new Set(glosses).size !== glosses.length) {
    reasons.push("duplicate gloss text");
  }

  for (const gloss of glosses) {
    if (gloss.length > input.maxGlossLength) {
      reasons.push(`gloss too long: ${gloss}`);
    }
    if (containsSentencePunctuation(gloss)) {
      reasons.push(`gloss contains sentence punctuation: ${gloss}`);
    }
    if (input.lang === "zh-tw" || input.lang === "zh-cn") {
      if (!hasHanText(gloss)) {
        reasons.push(`Chinese gloss has no Han text: ${gloss}`);
      }
      if (hasSuspiciousLatinText(gloss)) {
        reasons.push(`Chinese gloss contains suspicious Latin text: ${gloss}`);
      }
      if (input.sourceGlosses && isOverlyGenericChineseGloss(gloss, input.sourceGlosses)) {
        reasons.push(`Chinese gloss is too generic for this sense: ${gloss}`);
      }
    }
  }

  return Array.from(new Set(reasons));
}

export function sourceKey(row: Pick<AiGlossSource, "senseId" | "lang">): string {
  return `${row.senseId}:${row.lang}`;
}

export function formatJsonl(rows: unknown[]): string {
  return rows.length > 0 ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "";
}

function containsSentencePunctuation(gloss: string): boolean {
  return /[。！？!?]/.test(gloss) || gloss.includes("\n");
}

function hasHanText(gloss: string): boolean {
  return /\p{Script=Han}/u.test(gloss);
}

function hasSuspiciousLatinText(gloss: string): boolean {
  return /[A-Za-z]{2,}/.test(gloss);
}

function isOverlyGenericChineseGloss(gloss: string, sourceGlosses: string[]): boolean {
  const genericGlosses = new Set(["在", "來", "去", "做", "有", "是"]);
  if (!genericGlosses.has(gloss)) return false;

  return sourceGlosses.some((sourceGloss) => sourceGloss.includes("(") || sourceGloss.split(/\s+/).length >= 3);
}
