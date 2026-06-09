import type { ApiLang } from "../src/types";

export const defaultGeminiModel = "gemini-3-flash-preview";
export const thinkingLevel = "low" as const;

export type AiSeed = {
  entryId: string;
  senseId: string;
  word: string;
  reading: string | null;
  common: boolean;
  position: number;
  targetLang: ApiLang;
  pos: string[];
  glosses: string[];
};

export type Candidate = {
  entryId: string;
  senseId: string;
  word: string;
  reading: string | null;
  targetLang: ApiLang;
  sourceGlosses: string[];
  candidateGlosses: string[];
  model: string;
  thinkingLevel: typeof thinkingLevel;
};

export type GeminiGenerateContentRequest = {
  contents: Array<{
    role: "user";
    parts: Array<{ text: string }>;
  }>;
  generationConfig: {
    thinkingConfig: {
      thinkingLevel: typeof thinkingLevel;
    };
    responseMimeType: "application/json";
  };
};

export type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function makeGenerateContentRequest(seed: AiSeed): GeminiGenerateContentRequest {
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: promptFor(seed) }]
      }
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel
      },
      responseMimeType: "application/json"
    }
  };
}

export function candidateFromResponse(seed: AiSeed, model: string, response: GeminiResponse): Candidate {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const parsed = parseGlossResponse(text);

  return candidateFromGlosses(seed, model, parsed.glosses);
}

export function candidateFromGlosses(seed: AiSeed, model: string, candidateGlosses: string[]): Candidate {
  return {
    entryId: seed.entryId,
    senseId: seed.senseId,
    word: seed.word,
    reading: seed.reading,
    targetLang: seed.targetLang,
    sourceGlosses: seed.glosses,
    candidateGlosses,
    model,
    thinkingLevel
  };
}

function promptFor(seed: AiSeed): string {
  const targetLanguage = targetLanguageInstruction(seed.targetLang);

  return [
    `Translate one JMdict Japanese sense into ${targetLanguage.name} dictionary glosses.`,
    "Return JSON only with this shape: {\"glosses\":[\"...\"]}.",
    "Rules:",
    `- Use ${targetLanguage.usage}.`,
    "- Return short dictionary glosses, not explanations.",
    "- Do not add examples.",
    "- Do not add a new sense.",
    "- Preserve the meaning of the English source glosses.",
    "",
    `Japanese word: ${seed.word}`,
    `Reading: ${seed.reading ?? ""}`,
    `Part of speech: ${seed.pos.join(", ")}`,
    `English source glosses: ${seed.glosses.join("; ")}`
  ].join("\n");
}

function targetLanguageInstruction(lang: ApiLang): { name: string; usage: string } {
  switch (lang) {
    case "zh-tw":
      return { name: "Traditional Chinese", usage: "Traditional Chinese used in Taiwan" };
    case "zh-cn":
      return { name: "Simplified Chinese", usage: "Simplified Chinese used in Mainland China" };
    case "ko":
      return { name: "Korean", usage: "natural Korean dictionary wording" };
    case "de":
      return { name: "German", usage: "natural German dictionary wording" };
    case "en":
      return { name: "English", usage: "natural English dictionary wording" };
  }
}

function parseGlossResponse(text: string): { glosses: string[] } {
  const parsed = parseJsonObject(text) as { glosses?: unknown };
  if (!Array.isArray(parsed.glosses) || !parsed.glosses.every((item) => typeof item === "string")) {
    throw new Error(`Gemini returned invalid gloss JSON: ${text}`);
  }

  return {
    glosses: parsed.glosses.map((item) => item.trim()).filter(Boolean)
  };
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const objectText = firstBalancedObject(text);
    if (!objectText) throw new Error(`Unable to parse JSON string: ${text}`);
    return JSON.parse(objectText);
  }
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return null;
}
