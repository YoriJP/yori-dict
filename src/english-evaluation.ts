export type EnglishReviewerJudgment = {
  id: string;
  expected: "accept" | "reject";
  actual: "accept" | "reject";
};

export function summarizeEnglishReviewerEvaluation(judgments: EnglishReviewerJudgment[]) {
  const defects = judgments.filter(({ expected }) => expected === "reject");
  const valid = judgments.filter(({ expected }) => expected === "accept");
  const falseAcceptance = defects.filter(({ actual }) => actual === "accept").length;
  const falseRejection = valid.filter(({ actual }) => actual === "reject").length;
  return {
    total: judgments.length,
    falseAcceptance: {
      count: falseAcceptance,
      totalDefects: defects.length,
      rate: defects.length === 0 ? 0 : falseAcceptance / defects.length
    },
    falseRejection: {
      count: falseRejection,
      totalValid: valid.length,
      rate: valid.length === 0 ? 0 : falseRejection / valid.length
    },
    releaseBlocked: falseAcceptance > 0
  };
}
