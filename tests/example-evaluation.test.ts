import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  generatorConfig,
  reviewerConfig,
  reviewReasonCodes,
  translatorConfig,
  type ModelCall
} from "../src/example-enrichment";
import { runEvaluation, type EvaluationInputs } from "../scripts/evaluate-examples";

const repoRoot = join(import.meta.dir, "..");

test("scores every repeated corpus attempt and every labelled reviewer mutation", async () => {
  const inputs = await fixtureInputs();
  const result = await runEvaluation(inputs, healthyModelCall);

  expect(result.generation).toHaveLength(2);
  for (const candidate of result.generation) {
    expect(candidate.attempted).toBe(inputs.corpus.length * inputs.repeats);
    expect(candidate.passed).toBe(candidate.attempted);
    expect(candidate.failed).toBe(0);
    expect(candidate.outcomes).toHaveLength(candidate.attempted);
    expect(candidate.bySlice["should-abstain"]).toEqual({ attempted: 4, passed: 4, failed: 0 });
  }
  expect(result.reviewerCalibration.falseAccepts).toEqual({ count: 0, denominator: 6, rate: 0 });
  expect(result.reviewerCalibration.falseRejects).toEqual({ count: 0, denominator: 6, rate: 0 });
  expect(result.reviewerCalibration.exactLabels).toEqual({ count: 12, denominator: 12, rate: 1 });
  expect(result.reviewerCalibration.outcomes).toHaveLength(12);
  expect(result.generatorCandidates).toEqual(inputs.generatorCandidates);
  expect(result.reviewerConfig).toEqual(inputs.reviewer);
  expect(result.translatorConfig).toEqual(inputs.translator);
});

test("counts malformed reviewer responses as failures instead of dropping attempts", async () => {
  const inputs = await fixtureInputs();
  const malformedReviewer: ModelCall = async (input) =>
    input.role === "reviewer" ? "" : healthyModelCall(input);
  const result = await runEvaluation(inputs, malformedReviewer);

  for (const candidate of result.generation) {
    expect(candidate.attempted).toBe(inputs.corpus.length * inputs.repeats);
    expect(candidate.outcomes).toHaveLength(candidate.attempted);
    expect(candidate.failed).toBe(8);
    expect(candidate.passed).toBe(4);
  }
  expect(result.reviewerCalibration.falseAccepts).toEqual({ count: 6, denominator: 6, rate: 1 });
  expect(result.reviewerCalibration.falseRejects).toEqual({ count: 6, denominator: 6, rate: 1 });
  expect(result.reviewerCalibration.outcomes.every((outcome) => !outcome.passed)).toBe(true);
  expect(result.reviewerCalibration.outcomes.every((outcome) => outcome.actualDecision === "invalid_or_missing")).toBe(true);
});

test("does not hide a reviewer that rejects defects with the wrong reason", async () => {
  const inputs = await fixtureInputs();
  const oneReasonReviewer: ModelCall = async (input) => {
    if (input.role !== "reviewer") return healthyModelCall(input);
    const id = input.prompt.match(/\{"id":"([^"]+)","decision":"accept"/)?.[1];
    if (!id) throw new Error("Reviewer prompt has no candidate id");
    return id.endsWith(":mutation")
      ? JSON.stringify({ id, decision: "reject", reason: "unnatural" })
      : JSON.stringify({ id, decision: "accept" });
  };
  const result = await runEvaluation(inputs, oneReasonReviewer);

  expect(result.reviewerCalibration.falseAccepts).toEqual({ count: 0, denominator: 6, rate: 0 });
  expect(result.reviewerCalibration.falseRejects).toEqual({ count: 0, denominator: 6, rate: 0 });
  expect(result.reviewerCalibration.exactLabels).toEqual({ count: 7, denominator: 12, rate: 7 / 12 });
  expect(result.reviewerCalibration.outcomes.filter((outcome) => outcome.classification === "wrong_reason")).toHaveLength(5);
  expect(result.reviewerCalibration.outcomes.find((outcome) => outcome.caseId === "wrong-sense-pull:mutation")?.label).toBe(
    "wrong_sense"
  );
});

test("fixed fixtures cover all slices, exact model triples, and one mutation per reason", async () => {
  const inputs = await fixtureInputs();

  expect(new Set(inputs.corpus.map((item) => item.slice))).toEqual(
    new Set(["easy", "polysemous", "kana-only", "should-abstain", "zh-tw-trap"])
  );
  expect(inputs.corpus.filter((item) => item.slice === "should-abstain").every((item) => item.expect === "abstain")).toBe(true);
  expect(inputs.generatorCandidates).toContainEqual(generatorConfig);
  expect(inputs.translator).toEqual(translatorConfig);
  expect(inputs.reviewer).toEqual(reviewerConfig);
  expect(new Set(inputs.calibration.map((item) => item.expectedReason))).toEqual(new Set(reviewReasonCodes));
  expect(inputs.calibration.every((item) => Object.keys(item.mutation).includes("kind"))).toBe(true);
});

async function fixtureInputs(): Promise<EvaluationInputs> {
  const [corpus, calibration, configs] = await Promise.all([
    Bun.file(join(repoRoot, "fixtures/example-evaluation-corpus.json")).json(),
    Bun.file(join(repoRoot, "fixtures/example-review-calibration.json")).json(),
    Bun.file(join(repoRoot, "fixtures/example-evaluation-configs.json")).json()
  ]);
  return {
    runId: "test-run",
    repeats: 2,
    timeoutMs: 1_000,
    corpus: corpus.cases as EvaluationInputs["corpus"],
    calibration: calibration.cases as EvaluationInputs["calibration"],
    generatorCandidates: configs.generatorCandidates as EvaluationInputs["generatorCandidates"],
    translator: configs.translator as EvaluationInputs["translator"],
    reviewer: configs.reviewer as EvaluationInputs["reviewer"],
    sourceDigests: { corpus: "sha256:test", calibration: "sha256:test", configs: "sha256:test" },
    gitCommit: "test-commit"
  };
}

const healthyModelCall: ModelCall = async (input) => {
  if (input.role === "translator") {
    const sentence = input.prompt.match(/^sentence: (.+)$/m)?.[1] ?? "";
    const translations: Record<string, string> = {
      "毎朝、学校まで歩いて行く。": "我每天早上走路去學校。",
      "先生は辞書から例を引いて説明した。": "老師引用字典裡的例子說明。",
      "その子犬はとてもかわいい。": "那隻小狗很可愛。",
      "新しいソフトウェアを仕事で使う。": "我工作時使用新的軟體。"
    };
    const translation = translations[sentence];
    if (!translation) throw new Error(`Unexpected translator sentence ${sentence}`);
    return JSON.stringify({ translation });
  }
  if (input.role === "generator") {
    const word = input.prompt.match(/^word: (.+)$/m)?.[1];
    switch (word) {
      case "学校":
        return candidate("毎朝、学校まで歩いて行く。", "I walk to school every morning.", "我每天早上走路去學校。");
      case "引く":
        return candidate(
          "先生は辞書から例を引いて説明した。",
          "The teacher cited an example from a dictionary.",
          "老師引用字典裡的例子說明。"
        );
      case "かわいい":
        return candidate("その子犬はとてもかわいい。", "That puppy is very cute.", "那隻小狗很可愛。");
      case "畏し":
        return JSON.stringify({ abstain: true, reason: "archaic" });
      case "東京":
        return JSON.stringify({ abstain: true, reason: "not_standalone" });
      case "ソフトウェア":
        return candidate(
          "新しいソフトウェアを仕事で使う。",
          "I use new software at work.",
          "我工作時使用新的軟體。"
        );
      default:
        throw new Error(`Unexpected generator word ${word}`);
    }
  }

  const id = input.prompt.match(/\{"id":"([^"]+)","decision":"accept"/)?.[1];
  if (!id) throw new Error("Reviewer prompt has no candidate id");
  if (id.endsWith(":mutation")) {
    const reasonByCase: Record<string, string> = {
      "wrong-sense-pull": "wrong_sense",
      "unnatural-word-order": "unnatural",
      "too-complex-wording": "too_complex",
      "mismatched-translation": "translation_mismatch",
      "prc-video-term": "zh_tw_style",
      "unsafe-instructions": "unsafe_content"
    };
    const caseId = id.slice(0, -":mutation".length);
    return JSON.stringify({ id, decision: "reject", reason: reasonByCase[caseId] });
  }
  return JSON.stringify({ id, decision: "accept" });
};

function candidate(sentence: string, en: string, zhTw: string): string {
  void zhTw;
  return JSON.stringify({ sentence, english: en });
}
