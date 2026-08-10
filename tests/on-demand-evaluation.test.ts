import { expect, test } from "bun:test";

test("the no-spend regression corpus covers hard terms and seeded defect classes", async () => {
  const corpus = await Bun.file("fixtures/on-demand-regression-corpus.json").json() as {
    eligibility: Array<{ candidate: string }>;
    reviewDefects: Array<{ id: string }>;
  };
  expect(corpus.eligibility.map((test) => test.candidate)).toEqual([
    "情報", "動画", "適当", "結構", "大丈夫", "生", "忖度", "やばい"
  ]);
  expect(corpus.reviewDefects.map((test) => test.id)).toEqual([
    "invented-meaning", "missing-sense", "merged-pos", "wrong-pronunciation",
    "circular-definition", "unsupported-label", "mainland-terminology",
    "political-misinformation", "partisan-framing"
  ]);
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
