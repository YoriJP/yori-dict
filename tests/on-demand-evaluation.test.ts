import { expect, test } from "bun:test";
import {
  onDemandEvaluationContracts,
  ModelGatewayError,
  type ModelGateway,
  type ModelRequest
} from "../src/on-demand-dictionary";
import { evaluateReview, reviewCases, type ReviewCase } from "../src/on-demand-evaluation";

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
  const [request] = onDemandEvaluationContracts.exampleReview("candidate", {
    explanationLanguage: "en",
    entry: { word: "学校", reading: "がっこう" },
    sense: { glosses: [{ text: "school" }] },
    example: {
      text: "学校で日本語を勉強しています。",
      translations: [{ lang: "en", text: "I study Japanese at school." }]
    }
  });

  expect(request.promptVersion).toBe("example-review-v7");
  expect(request.prompt).toStartWith("Return exactly one token: ACCEPT or REJECT.");
  expect(request.prompt).toContain("# Criteria");
  expect(request.prompt).toContain("# Candidate");
  expect(request.prompt).not.toContain("# Role");
  expect(request.prompt).not.toContain("# Task");
  expect(request.prompt).not.toContain("Reject only.");
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

test("generated-entry review cases can be selected and repeated before model setup", async () => {
  const corpus = await Bun.file("fixtures/on-demand-regression-corpus.json").json();
  expect(corpus.entryReviews.filter((test: { expected: string }) => test.expected === "accepted")).toHaveLength(2);
  expect(corpus.entryReviews.filter((test: { expected: string }) => test.expected === "rejected")).toHaveLength(6);
  for (const id of ["folklore-generated", "bridge-pile-generated", "invented-meaning", "wrong-sense"]) {
    const child = Bun.spawn([
      "bun", "run", "scripts/evaluate-on-demand.ts", "--run",
      "--review-case", id, "--repeat", "3"
    ], {
      cwd: process.cwd(),
      env: { ...Bun.env, OPENROUTER_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("OPENROUTER_API_KEY is required.");
  }
});

for (const { kind, responses, expected } of [
  { kind: "entry", responses: ["ACCEPT", "ACCEPT"], expected: "accepted" },
  { kind: "entry", responses: ["REJECT"], expected: "rejected" },
  { kind: "entry", responses: ["ACCEPT because it is correct"], expected: "malformed" },
  { kind: "entry", responses: ["ACCEPT", "REJECT"], expected: "rejected" },
  { kind: "entry", responses: ["ACCEPT", "accept"], expected: "malformed" },
  { kind: "example", responses: ["ACCEPT"], expected: "accepted" },
  { kind: "example", responses: ["REJECT"], expected: "rejected" },
  { kind: "example", responses: ["ACCEPT."], expected: "malformed" }
] as const) {
  test(`${kind} evaluation handles ${responses.join("/")} without another model call`, async () => {
    const { gateway, calls } = scriptedReviews(responses);
    const candidate = { explanationLanguage: "zh-tw", entry: { word: "民間伝承" } };
    const testCase: ReviewCase = { id: "hidden-defect-label", kind, expected: "rejected", candidate };

    expect(await evaluateReview(testCase, gateway)).toBe(expected);
    expect(calls).toHaveLength(responses.length);
    expect(calls[0].role).toBe(kind === "entry" ? "entry-review" : "example-review");
    for (const call of calls) {
      expect(call.requestedServiceTier).toBe("standard");
      expect(call.prompt).not.toContain(testCase.id);
      expect(JSON.parse(call.prompt.split("candidate: ")[1])).toEqual(candidate);
    }
    if (calls.length === 2) {
      expect(calls[1].prompt).toStartWith("# Verification Context");
      expect(calls[1].prompt).toEndWith(calls[0].prompt);
    }
  });
}

for (const responsesBeforeFailure of [[], ["ACCEPT"]]) {
  test(`entry evaluation propagates provider failure on pass ${responsesBeforeFailure.length + 1}`, async () => {
    const error = new ModelGatewayError("transient", "provider unavailable");
    const { gateway, calls } = scriptedReviews([...responsesBeforeFailure, error]);
    await expect(evaluateReview({
      id: "valid-entry", kind: "entry", expected: "accepted", candidate: {}
    }, gateway)).rejects.toBe(error);
    expect(calls).toHaveLength(responsesBeforeFailure.length + 1);
  });
}

test("review corpus normalization preserves candidates and expected verdicts", () => {
  const candidate = { entry: { word: "民間伝承" } };
  const cases = reviewCases({
    reviewDefects: [{ id: "entry-defect", candidate }],
    entryReviews: [{ id: "valid-entry", expected: "accepted", candidate }],
    acceptedExamples: [{ id: "valid-example", candidate }],
    rejectedExamples: [{ id: "example-defect", candidate }]
  });
  expect(cases).toEqual([
    { id: "entry-defect", kind: "entry", expected: "rejected", candidate },
    { id: "valid-entry", kind: "entry", expected: "accepted", candidate },
    { id: "valid-example", kind: "example", expected: "accepted", candidate },
    { id: "example-defect", kind: "example", expected: "rejected", candidate }
  ]);
  expect(reviewCases({ reviewDefects: [], acceptedExamples: [], rejectedExamples: [] })).toEqual([]);
});

function scriptedReviews(responses: readonly (string | Error)[]) {
  const calls: ModelRequest[] = [];
  const gateway: ModelGateway = {
    async call(request) {
      const response = responses[calls.length];
      calls.push(request);
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("Unexpected model call");
      return {
        text: response,
        requestId: `review-${calls.length}`,
        model: request.model,
        provider: "scripted",
        effectiveServiceTier: request.requestedServiceTier,
        inputTokens: 0,
        outputTokens: 0
      };
    }
  };
  return { gateway, calls };
}
