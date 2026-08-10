import { expect, test } from "bun:test";
import { onDemandEvaluationContracts } from "../src/on-demand-dictionary";

test("the no-spend regression corpus covers hard terms and seeded defect classes", async () => {
  const corpus = await Bun.file("fixtures/on-demand-regression-corpus.json").json() as {
    eligibility: Array<{ candidate: string }>;
    reviewDefects: Array<{ id: string }>;
    acceptedExamples: Array<{ id: string }>;
    rejectedExamples: Array<{ id: string }>;
  };
  expect(corpus.eligibility.map((test) => test.candidate)).toEqual([
    "情報", "動画", "適当", "結構", "大丈夫", "生", "忖度", "やばい"
  ]);
  expect(corpus.reviewDefects.map((test) => test.id)).toEqual([
    "invented-meaning", "missing-sense", "merged-pos", "wrong-pronunciation",
    "circular-definition", "unsupported-label", "mainland-terminology",
    "political-misinformation", "partisan-framing"
  ]);
  expect(corpus.acceptedExamples.map((test) => test.id)).toEqual([
    "school-en", "school-zh-tw", "inflected-verb-en", "inflected-verb-zh-tw",
    "polysemous-interjection-en", "polysemous-interjection-zh-tw",
    "colloquial-adjective-en", "colloquial-adjective-zh-tw",
    "taiwan-terminology-zh-tw", "loanword-en"
  ]);
  expect(corpus.rejectedExamples.map((test) => test.id)).toEqual([
    "wrong-sense", "translation-mismatch", "mainland-example-terminology",
    "headword-not-used", "unsafe-framing"
  ]);
});

test("the example reviewer receives a lean fail-closed decision prompt", () => {
  const prompt = onDemandEvaluationContracts.exampleReview.prompt("candidate", {
    explanationLanguage: "en",
    entry: { word: "学校", reading: "がっこう" },
    sense: { glosses: [{ text: "school" }] },
    example: {
      text: "学校で日本語を勉強しています。",
      translations: [{ lang: "en", text: "I study Japanese at school." }]
    }
  });

  expect(onDemandEvaluationContracts.exampleReview.promptVersion).toBe("example-review-v6");
  expect(prompt).toStartWith("Return exactly one token: ACCEPT or REJECT.");
  expect(prompt).toContain("# Criteria");
  expect(prompt).toContain("# Candidate");
  expect(prompt).not.toContain("# Role");
  expect(prompt).not.toContain("# Task");
  expect(prompt).not.toContain("Reject only.");
});

test("the paid evaluation refuses to call a model without an explicit --run", async () => {
  const child = Bun.spawn(["bun", "run", "scripts/evaluate-on-demand.ts"], {
    cwd: process.cwd(),
    env: { ...Bun.env, OPENROUTER_API_KEY: "should-not-be-used" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("Paid evaluation is disabled");
});

test("a targeted paid evaluation refuses an unknown case before model setup", async () => {
  const child = Bun.spawn([
    "bun", "run", "scripts/evaluate-on-demand.ts", "--run", "--case", "missing-case"
  ], {
    cwd: process.cwd(),
    env: { ...Bun.env, OPENROUTER_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("Eval case not found: missing-case");
});

test("a targeted reviewer evaluation refuses an unknown case before model setup", async () => {
  const child = Bun.spawn([
    "bun", "run", "scripts/evaluate-on-demand.ts", "--run", "--review-case", "missing-case"
  ], {
    cwd: process.cwd(),
    env: { ...Bun.env, OPENROUTER_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("Review eval case not found: missing-case");
});

test("a repeated reviewer evaluation requires a positive integer before model setup", async () => {
  const child = Bun.spawn([
    "bun", "run", "scripts/evaluate-on-demand.ts", "--run",
    "--review-case", "school-en", "--repeat", "0"
  ], {
    cwd: process.cwd(),
    env: { ...Bun.env, OPENROUTER_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("--repeat requires a positive integer");
});

test("a targeted paid evaluation requires a non-empty case selector", async () => {
  for (const suffix of [["--case"], ["--case", ""]]) {
    const child = Bun.spawn([
      "bun", "run", "scripts/evaluate-on-demand.ts", "--run", ...suffix
    ], {
      cwd: process.cwd(),
      env: { ...Bun.env, OPENROUTER_API_KEY: "should-not-be-used" },
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("--case requires a non-empty candidate");
  }
});
