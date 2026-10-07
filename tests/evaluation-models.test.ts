import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Japanese evaluation preserves GPT-6 Luna's production eligibility effort", async () => {
  const calls = await captureEvaluationRequests("scripts/evaluate-on-demand.ts", ["--case", "情報"], "eligibility");
  expect(calls).toEqual([{
    role: "eligibility", model: "openai/gpt-6-luna", reasoningEffort: "low", requestedServiceTier: "standard"
  }]);
});

test("English evaluation preserves author and reviewer effort from their model contracts", async () => {
  const calls = await captureEvaluationRequests("scripts/evaluate-english.ts", [
    "--author-model", "openai/gpt-6-luna",
    "--author-model", "google/gemini-3-flash-preview",
    "--reviewer-model", "openai/gpt-6-luna",
    "--reviewer-model", "google/gemini-3-flash-preview"
  ], "entry-author");
  expect(calls.some(({ role }) => role === "entry-author")).toBe(true);
  expect(new Set(calls.map(({ model }) => model))).toEqual(new Set([
    "openai/gpt-6-luna", "google/gemini-3-flash-preview"
  ]));
  for (const call of calls) {
    expect(call.reasoningEffort).toBe(call.model === "openai/gpt-6-luna" ? "low" : "minimal");
    expect(call.requestedServiceTier).toBe("standard");
  }
});

type CapturedRequest = {
  role: string;
  model: string;
  reasoningEffort: string;
  requestedServiceTier: string;
};

async function captureEvaluationRequests(script: string, args: string[], stopRole: string): Promise<CapturedRequest[]> {
  const directory = await mkdtemp(join(tmpdir(), "yori-evaluation-models-"));
  try {
    const preload = join(directory, "gateway.ts");
    const gatewayPath = new URL("../src/model-gateway.ts", import.meta.url).pathname;
    await Bun.write(preload, `
      import { mock } from "bun:test";
      globalThis.fetch = async () => { throw new Error("Network calls are disabled in this test"); };
      mock.module(${JSON.stringify(gatewayPath)}, () => ({
        createOpenRouterModelGateway() {
          return { async call(request) {
            const { role, model, reasoningEffort, requestedServiceTier } = request;
            console.log("CAPTURED " + JSON.stringify({ role, model, reasoningEffort, requestedServiceTier }));
            if (role === ${JSON.stringify(stopRole)}) process.exit(0);
            return { text: "ACCEPT" };
          } };
        }
      }));
    `);
    const child = Bun.spawn(["bun", "--preload", preload, script, "--run", ...args, "--out-dir", directory], {
      cwd: process.cwd(),
      env: { ...Bun.env, OPENROUTER_API_KEY: "mock-key" },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    return stdout.split("\n").filter((line) => line.startsWith("CAPTURED "))
      .map((line) => JSON.parse(line.slice("CAPTURED ".length)) as CapturedRequest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
