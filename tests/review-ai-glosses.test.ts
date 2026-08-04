import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..");
const reviewScript = join(repoRoot, "scripts", "review-ai-glosses.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepares a bounded AI-gloss review bundle without invoking Claude", async () => {
  const fixture = await createReviewFixture();
  const result = runReview(fixture);

  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain("Claude review prompt:");
  const rows = await readJsonl(fixture.bundlePath);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    senseId: "yori:s_jmdict_1358280_1",
    word: "食べる",
    reading: "たべる",
    englishGlosses: ["to eat"],
    aiGlosses: ["食用"]
  });
  expect(existsSync(fixture.issuesPath)).toBe(false);
});

test("rejects review bundles larger than 500 rows", () => {
  const result = Bun.spawnSync(["bun", "run", reviewScript, "--limit", "501"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe"
  });

  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("--limit must not exceed 500");
});

test("runs a bounded no-tools review and validates JSONL issues", async () => {
  const fixture = await createReviewFixture();
  const fakeClaude = createFakeClaude(fixture.directory);
  const result = runReview(fixture, ["--run", "--max-budget-usd", "0.25"], {
    PATH: `${fakeClaude.binDir}:${process.env.PATH ?? ""}`,
    CLAUDE_ARGS_LOG: fakeClaude.argsLog,
    CLAUDE_STDIN_LOG: fakeClaude.stdinLog,
    CLAUDE_FAKE_OUTPUT: JSON.stringify({
      senseId: "yori:s_jmdict_1358280_1",
      severity: "high",
      reason: "The gloss is too broad.",
      suggestedGlosses: ["吃"]
    })
  });

  expect(result.exitCode).toBe(0);
  const args = readFileSync(fakeClaude.argsLog, "utf8").split("\n");
  expect(args).toContain("--safe-mode");
  expect(args).toContain("--no-session-persistence");
  expect(args).toContain("--tools");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  expect(args).toContain("--max-budget-usd");
  expect(args).toContain("0.25");
  expect(readFileSync(fakeClaude.stdinLog, "utf8")).toContain('"aiGlosses":["食用"]');
  expect(await readJsonl(fixture.issuesPath)).toEqual([
    {
      senseId: "yori:s_jmdict_1358280_1",
      severity: "high",
      reason: "The gloss is too broad.",
      suggestedGlosses: ["吃"]
    }
  ]);
  expect(readFileSync(join(fixture.directory, "claude.stderr.log"), "utf8")).toContain(
    "fake diagnostic"
  );
});

test("accepts an empty Claude response as no issues", async () => {
  const fixture = await createReviewFixture();
  const fakeClaude = createFakeClaude(fixture.directory);
  const result = runReview(fixture, ["--run"], {
    PATH: `${fakeClaude.binDir}:${process.env.PATH ?? ""}`,
    CLAUDE_ARGS_LOG: fakeClaude.argsLog,
    CLAUDE_STDIN_LOG: fakeClaude.stdinLog,
    CLAUDE_FAKE_OUTPUT: ""
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(fixture.issuesPath, "utf8")).toBe("");
});

test("fails closed when Claude returns invalid or out-of-scope issues", async () => {
  const fixture = await createReviewFixture();
  const fakeClaude = createFakeClaude(fixture.directory);
  const result = runReview(fixture, ["--run"], {
    PATH: `${fakeClaude.binDir}:${process.env.PATH ?? ""}`,
    CLAUDE_ARGS_LOG: fakeClaude.argsLog,
    CLAUDE_STDIN_LOG: fakeClaude.stdinLog,
    CLAUDE_FAKE_OUTPUT: JSON.stringify({
      senseId: "yori:s_jmdict_missing_1",
      severity: "high",
      reason: "Not in this bundle.",
      suggestedGlosses: []
    })
  });

  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("not present in the review bundle");
  expect(readFileSync(fixture.issuesPath, "utf8")).toBe("");
  expect(readFileSync(join(fixture.directory, "claude.raw.txt"), "utf8")).toContain(
    "yori:s_jmdict_missing_1"
  );
});

test("keeps default artifacts separate for sequential offsets", async () => {
  const fixture = await createDefaultReviewFixture();
  const fakeClaude = createFakeClaude(fixture.directory);
  const baseEnv = {
    PATH: `${fakeClaude.binDir}:${process.env.PATH ?? ""}`,
    CLAUDE_ARGS_LOG: fakeClaude.argsLog,
    CLAUDE_STDIN_LOG: fakeClaude.stdinLog
  };

  const first = runDefaultReview(fixture.directory, 0, {
    ...baseEnv,
    CLAUDE_FAKE_OUTPUT: reviewIssue("yori:s_jmdict_1358280_1")
  });
  const second = runDefaultReview(fixture.directory, 1, {
    ...baseEnv,
    CLAUDE_FAKE_OUTPUT: reviewIssue("yori:s_jmdict_1206730_1")
  });

  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  const firstIssues = join(
    fixture.directory,
    "data",
    "ai-review",
    "zh-tw",
    "offset-0",
    "issues.jsonl"
  );
  const secondIssues = join(
    fixture.directory,
    "data",
    "ai-review",
    "zh-tw",
    "offset-1",
    "issues.jsonl"
  );
  expect(await readJsonl(firstIssues)).toEqual([
    expect.objectContaining({ senseId: "yori:s_jmdict_1358280_1" })
  ]);
  expect(await readJsonl(secondIssues)).toEqual([
    expect.objectContaining({ senseId: "yori:s_jmdict_1206730_1" })
  ]);
});

test("invalidates stale issues before rerunning a checkpoint", async () => {
  const fixture = await createDefaultReviewFixture();
  const fakeClaude = createFakeClaude(fixture.directory);
  const baseEnv = {
    PATH: `${fakeClaude.binDir}:${process.env.PATH ?? ""}`,
    CLAUDE_ARGS_LOG: fakeClaude.argsLog,
    CLAUDE_STDIN_LOG: fakeClaude.stdinLog
  };
  const issuesPath = join(
    fixture.directory,
    "data",
    "ai-review",
    "zh-tw",
    "offset-0",
    "issues.jsonl"
  );

  const valid = runDefaultReview(fixture.directory, 0, {
    ...baseEnv,
    CLAUDE_FAKE_OUTPUT: reviewIssue("yori:s_jmdict_1358280_1")
  });
  const invalid = runDefaultReview(fixture.directory, 0, {
    ...baseEnv,
    CLAUDE_FAKE_OUTPUT: "not jsonl"
  });

  expect(valid.exitCode).toBe(0);
  expect(invalid.exitCode).not.toBe(0);
  expect(readFileSync(issuesPath, "utf8")).toBe("");
});

type ReviewFixture = {
  directory: string;
  dbPath: string;
  sourcePath: string;
  bundlePath: string;
  issuesPath: string;
};

async function createReviewFixture(): Promise<ReviewFixture> {
  const directory = mkdtempSync(join(tmpdir(), "yori-ai-review-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "review.sqlite");
  const sourcePath = join(directory, "source.jsonl");
  const bundlePath = join(directory, "review-bundle.jsonl");
  const issuesPath = join(directory, "issues.jsonl");

  const imported = Bun.spawnSync(
    [
      "bun",
      "run",
      join(repoRoot, "scripts", "import-jmdict.ts"),
      "--input",
      join(repoRoot, "fixtures", "jmdict-sample.json"),
      "--out",
      dbPath
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
  );
  if (imported.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(imported.stderr));
  }

  await Bun.write(
    sourcePath,
    `${JSON.stringify({
      senseId: "yori:s_jmdict_1358280_1",
      lang: "zh-tw",
      glosses: ["食用"],
      source: "ai-assisted",
      model: "test-model"
    })}\n`
  );

  return { directory, dbPath, sourcePath, bundlePath, issuesPath };
}

async function createDefaultReviewFixture(): Promise<{ directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "yori-ai-review-default-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "data", "yori.sqlite");
  const sourcePath = join(directory, "sources", "ai-glosses", "zh-tw.jsonl");
  mkdirSync(join(directory, "data"), { recursive: true });
  mkdirSync(join(directory, "sources", "ai-glosses"), { recursive: true });

  const imported = Bun.spawnSync(
    [
      "bun",
      "run",
      join(repoRoot, "scripts", "import-jmdict.ts"),
      "--input",
      join(repoRoot, "fixtures", "jmdict-sample.json"),
      "--out",
      dbPath
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
  );
  if (imported.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(imported.stderr));
  }
  await Bun.write(
    sourcePath,
    [
      {
        senseId: "yori:s_jmdict_1358280_1",
        lang: "zh-tw",
        glosses: ["食用"],
        source: "ai-assisted",
        model: "test-model"
      },
      {
        senseId: "yori:s_jmdict_1206730_1",
        lang: "zh-tw",
        glosses: ["學校"],
        source: "ai-assisted",
        model: "test-model"
      }
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
  return { directory };
}

function runReview(
  fixture: ReviewFixture,
  extraArgs: string[] = [],
  env: Record<string, string> = {}
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      "bun",
      "run",
      reviewScript,
      "--lang",
      "zh-tw",
      "--limit",
      "1",
      "--db",
      fixture.dbPath,
      "--source",
      fixture.sourcePath,
      "--out",
      fixture.bundlePath,
      "--issues",
      fixture.issuesPath,
      ...extraArgs
    ],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env }
    }
  );
}

function runDefaultReview(
  directory: string,
  offset: number,
  env: Record<string, string>
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      "bun",
      "run",
      reviewScript,
      "--run",
      "--lang",
      "zh-tw",
      "--limit",
      "1",
      "--offset",
      String(offset)
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env }
    }
  );
}

function reviewIssue(senseId: string): string {
  return JSON.stringify({
    senseId,
    severity: "medium",
    reason: "Needs review.",
    suggestedGlosses: []
  });
}

function createFakeClaude(directory: string): {
  binDir: string;
  argsLog: string;
  stdinLog: string;
} {
  const binDir = join(directory, "bin");
  const argsLog = join(directory, "claude.args.txt");
  const stdinLog = join(directory, "claude.stdin.txt");
  const executable = join(binDir, "claude");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$CLAUDE_ARGS_LOG"',
      'cat > "$CLAUDE_STDIN_LOG"',
      'printf "%s\\n" "$CLAUDE_FAKE_OUTPUT"',
      'printf "fake diagnostic\\n" >&2'
    ].join("\n")
  );
  chmodSync(executable, 0o755);
  return { binDir, argsLog, stdinLog };
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
