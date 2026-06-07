import { normalizeQuery } from "./normalize";

export type DeinflectionCandidate = {
  text: string;
  reasons: string[];
};

type Rule = {
  suffix: string;
  replacement: string;
  reason: string;
};

const rules: Rule[] = [
  { suffix: "ませんでした", replacement: "る", reason: "polite negative past" },
  { suffix: "ません", replacement: "る", reason: "polite negative" },
  { suffix: "ました", replacement: "る", reason: "polite past" },
  { suffix: "ます", replacement: "る", reason: "polite" },
  { suffix: "なかった", replacement: "る", reason: "negative past" },
  { suffix: "ない", replacement: "る", reason: "negative" },
  { suffix: "た", replacement: "る", reason: "past" },
  { suffix: "て", replacement: "る", reason: "te-form" },
  { suffix: "くなかった", replacement: "い", reason: "i-adjective negative past" },
  { suffix: "くない", replacement: "い", reason: "i-adjective negative" },
  { suffix: "かった", replacement: "い", reason: "i-adjective past" },
  { suffix: "くて", replacement: "い", reason: "i-adjective te-form" },
  { suffix: "います", replacement: "う", reason: "godan polite" },
  { suffix: "きます", replacement: "く", reason: "godan polite" },
  { suffix: "ぎます", replacement: "ぐ", reason: "godan polite" },
  { suffix: "します", replacement: "す", reason: "godan polite" },
  { suffix: "ちます", replacement: "つ", reason: "godan polite" },
  { suffix: "にます", replacement: "ぬ", reason: "godan polite" },
  { suffix: "びます", replacement: "ぶ", reason: "godan polite" },
  { suffix: "みます", replacement: "む", reason: "godan polite" },
  { suffix: "ります", replacement: "る", reason: "godan polite" },
  { suffix: "んだ", replacement: "む", reason: "godan past" },
  { suffix: "んだ", replacement: "ぶ", reason: "godan past" },
  { suffix: "んだ", replacement: "ぬ", reason: "godan past" },
  { suffix: "んで", replacement: "む", reason: "godan te-form" },
  { suffix: "んで", replacement: "ぶ", reason: "godan te-form" },
  { suffix: "んで", replacement: "ぬ", reason: "godan te-form" },
  { suffix: "った", replacement: "う", reason: "godan past" },
  { suffix: "った", replacement: "つ", reason: "godan past" },
  { suffix: "った", replacement: "る", reason: "godan past" },
  { suffix: "って", replacement: "う", reason: "godan te-form" },
  { suffix: "って", replacement: "つ", reason: "godan te-form" },
  { suffix: "って", replacement: "る", reason: "godan te-form" },
  { suffix: "いた", replacement: "く", reason: "godan past" },
  { suffix: "いて", replacement: "く", reason: "godan te-form" },
  { suffix: "いだ", replacement: "ぐ", reason: "godan past" },
  { suffix: "いで", replacement: "ぐ", reason: "godan te-form" },
  { suffix: "した", replacement: "す", reason: "godan past" },
  { suffix: "して", replacement: "す", reason: "godan te-form" }
];

export function deinflect(query: string): DeinflectionCandidate[] {
  const normalized = normalizeQuery(query);
  const candidates = new Map<string, Set<string>>();

  for (const rule of rules) {
    if (!normalized.endsWith(rule.suffix) || normalized.length <= rule.suffix.length) {
      continue;
    }
    const stem = normalized.slice(0, -rule.suffix.length);
    const text = `${stem}${rule.replacement}`;
    if (text === normalized) continue;
    const reasons = candidates.get(text) ?? new Set<string>();
    reasons.add(rule.reason);
    candidates.set(text, reasons);
  }

  return Array.from(candidates, ([text, reasons]) => ({
    text,
    reasons: Array.from(reasons)
  }));
}
