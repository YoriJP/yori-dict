import type { ApiLang } from "./types";

const sourceToApiLang: Record<string, ApiLang> = {
  eng: "en",
  ger: "de",
  "zh-tw": "zh-tw",
  "zh-cn": "zh-cn",
  ko: "ko"
};

const supportedApiLangs = new Set<ApiLang>(["en", "de", "zh-tw", "zh-cn", "ko"]);

export function toApiLang(sourceLang: string): ApiLang | null {
  return sourceToApiLang[sourceLang] ?? null;
}

export function parseApiLang(value: string | null): ApiLang | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return supportedApiLangs.has(normalized as ApiLang) ? (normalized as ApiLang) : null;
}

export const apiLanguages = Array.from(supportedApiLangs);
