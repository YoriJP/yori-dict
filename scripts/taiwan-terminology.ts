import { Locale } from "opencc-js";

export type TaiwanTerminologyMatch = {
  term: string;
  replacement: string;
  index: number;
};

type TermPolicy = {
  replacement: string;
  matchPrefix?: boolean;
  requiredContext?: readonly string[];
};

// Reviewed, unambiguous cross-strait vocabulary from OpenCC's TWPhrases data.
// TWPhrases also contains preferences and context-dependent mappings, so using
// every entry as an error would reject valid Taiwanese text.
const reviewedOpenCcTerms = [
  "仿真",
  "信息",
  "用戶",
  "兼容",
  "創建",
  "批量",
  "接口",
  "數據",
  "文件夾",
  "智能",
  "查看",
  "界面",
  "算法",
  "網絡",
  "線程",
  "視頻",
  "變量",
  "軟件",
  "錄像",
  "隊列",
  "集成",
  "音頻",
  "屏幕",
  "寄存器",
  "遞歸",
  "默認",
  "枚舉"
] as const;

// Reviewed gaps in OpenCC 1.3.1's Taiwan phrase dictionary.
const auditedAdditions = new Map<string, TermPolicy>([
  ["幼兒園", { replacement: "幼稚園" }],
  ["初中", { replacement: "國中", matchPrefix: true }]
]);

// These OpenCC mappings are terminology errors only in a software context.
// The same words are valid Taiwanese for a restaurant menu, introducing a
// system, or deriving a conclusion.
const contextualOpenCcTerms = new Map<string, readonly string[]>([
  ["全局", ["變數", "變量", "作用域", "設定", "配置", "狀態", "物件", "函式", "函數"]],
  ["菜單", ["軟體", "應用程式", "介面", "下拉", "右鍵", "功能表"]],
  ["導入", ["檔案", "文件", "資料庫", "數據庫", "CSV", "JSON", "XML", "設定檔", "配置檔"]],
  ["導出", ["檔案", "文件", "資料庫", "數據庫", "CSV", "JSON", "XML", "設定檔", "配置檔"]]
]);

// These phrases contain a reviewed term but are established Taiwanese usages.
// Word segmentation handles the remaining overlap cases, such as 聚集成群.
const allowedPhrases = new Map<string, readonly string[]>([
  ["智能", ["智能障礙", "智能低下", "智能不足", "智能低下兒童", "重度智能障礙"]]
]);

const allowedTexts = new Map<string, readonly string[]>([
  ["接口", ["接口", "連接口", "木質接口"]],
  ["智能", ["智能"]]
]);

const segmenter = new Intl.Segmenter("zh-TW", { granularity: "word" });
const termPolicies = buildTermPolicies();

export function findPrcTerms(text: string): TaiwanTerminologyMatch[] {
  const segments = Array.from(segmenter.segment(text)).filter((segment) => segment.isWordLike);
  const matches: TaiwanTerminologyMatch[] = [];

  for (const [term, policy] of termPolicies) {
    let index = text.indexOf(term);
    while (index !== -1) {
      const end = index + term.length;
      const segment = segments.find((candidate) => candidate.index <= index && candidate.index + candidate.segment.length >= end);
      const isBoundaryMatch =
        segment !== undefined &&
        segment.index === index &&
        (segment.index + segment.segment.length === end || policy.matchPrefix === true);

      const localContext = clauseContaining(text, index, end);
      const hasRequiredContext =
        !policy.requiredContext || policy.requiredContext.some((context) => localContext.includes(context));
      if (isBoundaryMatch && hasRequiredContext && !isAllowedPhrase(text, index, end, term)) {
        matches.push({ term, replacement: policy.replacement, index });
      }

      index = text.indexOf(term, index + term.length);
    }
  }

  return matches.sort((left, right) => left.index - right.index || right.term.length - left.term.length);
}

function clauseContaining(text: string, start: number, end: number): string {
  const boundaries = /[，,。！？!?；;\n]/;
  let clauseStart = start;
  while (clauseStart > 0 && !boundaries.test(text[clauseStart - 1] ?? "")) clauseStart -= 1;
  let clauseEnd = end;
  while (clauseEnd < text.length && !boundaries.test(text[clauseEnd] ?? "")) clauseEnd += 1;
  return text.slice(clauseStart, clauseEnd);
}

function buildTermPolicies(): Map<string, TermPolicy> {
  const openCcMap = openCcTaiwanPhraseMap();
  const policies = new Map<string, TermPolicy>();

  for (const term of reviewedOpenCcTerms) {
    const replacement = openCcMap.get(term);
    if (!replacement || replacement === term) {
      throw new Error(`Reviewed Taiwan terminology term is missing from OpenCC TWPhrases: ${term}`);
    }
    policies.set(term, { replacement });
  }

  for (const [term, policy] of auditedAdditions) {
    policies.set(term, policy);
  }

  for (const [term, requiredContext] of contextualOpenCcTerms) {
    const replacement = openCcMap.get(term);
    if (!replacement || replacement === term) {
      throw new Error(`Contextual Taiwan terminology term is missing from OpenCC TWPhrases: ${term}`);
    }
    policies.set(term, { replacement, requiredContext });
  }

  return policies;
}

function openCcTaiwanPhraseMap(): Map<string, string> {
  const dictionary = Locale.to.twp[0]?.[0];
  if (typeof dictionary === "string") {
    return new Map(dictionary.split("|").map((entry) => entry.split(" ", 2) as [string, string]));
  }
  if (Array.isArray(dictionary)) {
    return new Map(dictionary as readonly [string, string][]);
  }
  throw new Error("OpenCC TWPhrases dictionary is unavailable");
}

function isAllowedPhrase(text: string, start: number, end: number, term: string): boolean {
  if ((allowedTexts.get(term) ?? []).includes(text)) return true;
  return (allowedPhrases.get(term) ?? []).some((phrase) => {
    let phraseStart = text.indexOf(phrase);
    while (phraseStart !== -1) {
      const phraseEnd = phraseStart + phrase.length;
      if (phraseStart <= start && phraseEnd >= end) return true;
      phraseStart = text.indexOf(phrase, phraseStart + phrase.length);
    }
    return false;
  });
}
