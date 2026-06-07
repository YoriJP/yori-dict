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
  { suffix: "られました", replacement: "る", reason: "ichidan passive polite past" },
  { suffix: "られます", replacement: "る", reason: "ichidan passive polite" },
  { suffix: "られた", replacement: "る", reason: "ichidan passive past" },
  { suffix: "られる", replacement: "る", reason: "ichidan passive" },
  { suffix: "られない", replacement: "る", reason: "ichidan passive negative" },
  { suffix: "られなかった", replacement: "る", reason: "ichidan passive negative past" },
  { suffix: "ませんでした", replacement: "る", reason: "polite negative past" },
  { suffix: "ません", replacement: "る", reason: "polite negative" },
  { suffix: "ました", replacement: "る", reason: "polite past" },
  { suffix: "ます", replacement: "る", reason: "polite" },
  { suffix: "わなかった", replacement: "う", reason: "godan negative past" },
  { suffix: "かなかった", replacement: "く", reason: "godan negative past" },
  { suffix: "がなかった", replacement: "ぐ", reason: "godan negative past" },
  { suffix: "さなかった", replacement: "す", reason: "godan negative past" },
  { suffix: "たなかった", replacement: "つ", reason: "godan negative past" },
  { suffix: "ななかった", replacement: "ぬ", reason: "godan negative past" },
  { suffix: "ばなかった", replacement: "ぶ", reason: "godan negative past" },
  { suffix: "まなかった", replacement: "む", reason: "godan negative past" },
  { suffix: "らなかった", replacement: "る", reason: "godan negative past" },
  { suffix: "わない", replacement: "う", reason: "godan negative" },
  { suffix: "かない", replacement: "く", reason: "godan negative" },
  { suffix: "がない", replacement: "ぐ", reason: "godan negative" },
  { suffix: "さない", replacement: "す", reason: "godan negative" },
  { suffix: "たない", replacement: "つ", reason: "godan negative" },
  { suffix: "なない", replacement: "ぬ", reason: "godan negative" },
  { suffix: "ばない", replacement: "ぶ", reason: "godan negative" },
  { suffix: "まない", replacement: "む", reason: "godan negative" },
  { suffix: "らない", replacement: "る", reason: "godan negative" },
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
  { suffix: "いませんでした", replacement: "う", reason: "godan polite negative past" },
  { suffix: "きませんでした", replacement: "く", reason: "godan polite negative past" },
  { suffix: "ぎませんでした", replacement: "ぐ", reason: "godan polite negative past" },
  { suffix: "しませんでした", replacement: "す", reason: "godan polite negative past" },
  { suffix: "ちませんでした", replacement: "つ", reason: "godan polite negative past" },
  { suffix: "にませんでした", replacement: "ぬ", reason: "godan polite negative past" },
  { suffix: "びませんでした", replacement: "ぶ", reason: "godan polite negative past" },
  { suffix: "みませんでした", replacement: "む", reason: "godan polite negative past" },
  { suffix: "りませんでした", replacement: "る", reason: "godan polite negative past" },
  { suffix: "いません", replacement: "う", reason: "godan polite negative" },
  { suffix: "きません", replacement: "く", reason: "godan polite negative" },
  { suffix: "ぎません", replacement: "ぐ", reason: "godan polite negative" },
  { suffix: "しません", replacement: "す", reason: "godan polite negative" },
  { suffix: "ちません", replacement: "つ", reason: "godan polite negative" },
  { suffix: "にません", replacement: "ぬ", reason: "godan polite negative" },
  { suffix: "びません", replacement: "ぶ", reason: "godan polite negative" },
  { suffix: "みません", replacement: "む", reason: "godan polite negative" },
  { suffix: "りません", replacement: "る", reason: "godan polite negative" },
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
