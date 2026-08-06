import { expect, test } from "bun:test";
import { summarizeEnglishReviewerEvaluation } from "../src/english-evaluation";

test("English reviewer evaluation blocks release on false acceptance separately from false rejection", () => {
  const summary = summarizeEnglishReviewerEvaluation([
    { id: "valid-1", expected: "accept", actual: "accept" },
    { id: "valid-2", expected: "accept", actual: "reject" },
    { id: "omission", expected: "reject", actual: "accept" },
    { id: "invented", expected: "reject", actual: "reject" }
  ]);

  expect(summary).toEqual({
    total: 4,
    falseAcceptance: { count: 1, totalDefects: 2, rate: 0.5 },
    falseRejection: { count: 1, totalValid: 2, rate: 0.5 },
    releaseBlocked: true
  });
});

test("English reviewer evaluation permits release only with zero false acceptance", () => {
  expect(summarizeEnglishReviewerEvaluation([
    { id: "valid", expected: "accept", actual: "reject" },
    { id: "defect", expected: "reject", actual: "reject" }
  ])).toMatchObject({
    falseAcceptance: { count: 0, totalDefects: 1, rate: 0 },
    falseRejection: { count: 1, totalValid: 1, rate: 1 },
    releaseBlocked: false
  });
});

test("the English paid reviewer calibration is explicit and covers every seeded defect class", async () => {
  const corpus = await Bun.file("fixtures/english-evaluation-corpus.json").json() as {
    reviewer: Array<{ id: string }>;
  };
  expect(corpus.reviewer.map(({ id }) => id)).toEqual(expect.arrayContaining([
    "omission", "invented-sense", "wrong-pronunciation", "merged-senses",
    "circular-definition", "unsupported-label", "misleading-example"
  ]));
  const child = Bun.spawn(["bun", "run", "scripts/evaluate-english.ts"], {
    cwd: process.cwd(), env: { ...process.env, OPENROUTER_API_KEY: "" }, stderr: "pipe"
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(stderr).toContain("Paid English evaluation is disabled");
});
