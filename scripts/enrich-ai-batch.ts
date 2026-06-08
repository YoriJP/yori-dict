import { dirname } from "node:path";
import {
  candidateFromResponse,
  defaultGeminiModel,
  makeGenerateContentRequest,
  readJsonl,
  type AiSeed,
  type Candidate,
  type GeminiResponse
} from "./ai-common";

type SubmitArgs = {
  inputPath: string;
  outPath: string;
  failuresPath: string | null;
  model: string;
  limit: number | null;
  workDir: string;
  displayName: string;
};

type CollectArgs = {
  manifestPath: string;
};

type Manifest = {
  batchName: string;
  displayName: string;
  uploadedFileName: string;
  requestPath: string;
  seedPath: string;
  resultPath: string;
  outPath: string;
  failuresPath: string;
  model: string;
  submittedAt: string;
};

type UploadedFile = {
  file?: {
    name?: string;
  };
};

type BatchResponse = {
  name?: string;
  state?: string;
  dest?: {
    fileName?: string;
    file_name?: string;
  };
  response?: {
    dest?: {
      fileName?: string;
      file_name?: string;
    };
    responsesFile?: string;
    responses_file?: string;
  };
  metadata?: {
    state?: string;
  };
  done?: boolean;
  error?: unknown;
};

type BatchResultLine = {
  key?: string;
  response?: GeminiResponse;
  status?: unknown;
  error?: unknown;
};

const command = Bun.argv[2];

if (command === "submit") {
  await submitBatch(parseSubmitArgs(Bun.argv.slice(3)));
} else if (command === "collect") {
  await collectBatch(parseCollectArgs(Bun.argv.slice(3)));
} else {
  throw new Error("Usage: bun run ai:batch -- submit|collect [options]");
}

async function submitBatch(args: SubmitArgs): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  const seeds = (await readJsonl<AiSeed>(args.inputPath)).slice(0, args.limit ?? undefined);
  if (seeds.length === 0) {
    throw new Error(`No seeds found in ${args.inputPath}`);
  }

  const runDir = `${args.workDir}/${timestampSlug()}`;
  const requestPath = `${runDir}/requests.jsonl`;
  const seedPath = `${runDir}/seeds.jsonl`;
  const resultPath = `${runDir}/results.jsonl`;
  const failuresPath = args.failuresPath ?? `${runDir}/failures.jsonl`;
  const manifestPath = `${runDir}/manifest.json`;

  await Bun.$`mkdir -p ${runDir}`;
  await Bun.write(
    requestPath,
    seeds.map((seed) => JSON.stringify({ key: seed.senseId, request: makeGenerateContentRequest(seed) })).join("\n") + "\n"
  );
  await Bun.write(seedPath, seeds.map((seed) => JSON.stringify(seed)).join("\n") + "\n");

  const uploadedFileName = await uploadRequestFile(requestPath, args.displayName, apiKey);
  const batchName = await createBatchJob(uploadedFileName, args.model, args.displayName, apiKey);

  const manifest: Manifest = {
    batchName,
    displayName: args.displayName,
    uploadedFileName,
    requestPath,
    seedPath,
    resultPath,
    outPath: args.outPath,
    failuresPath,
    model: args.model,
    submittedAt: new Date().toISOString()
  };

  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Submitted ${seeds.length} seed(s) as ${batchName}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Collect later: bun run ai:batch -- collect --manifest ${manifestPath}`);
}

async function collectBatch(args: CollectArgs): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  const manifest = JSON.parse(await Bun.file(args.manifestPath).text()) as Manifest;
  const batch = await getBatchJob(manifest.batchName, apiKey);
  const state = batchState(batch);

  if (!isSucceededState(state)) {
    console.log(`Batch ${manifest.batchName} is ${state}`);
    if (isFailedState(state)) {
      throw new Error(`Batch failed: ${JSON.stringify(batch.error ?? batch)}`);
    }
    return;
  }

  const resultFileName = batchResultFileName(batch);
  if (!resultFileName) {
    throw new Error(`Batch succeeded but no result file was found: ${JSON.stringify(batch)}`);
  }

  const resultText = await downloadFile(resultFileName, apiKey);
  await Bun.write(manifest.resultPath, resultText);

  const seeds = new Map((await readJsonl<AiSeed>(manifest.seedPath)).map((seed) => [seed.senseId, seed]));
  const candidates: Candidate[] = [];
  const failures: Array<{ key: string | null; reason: string; line: BatchResultLine }> = [];

  for (const line of resultText.split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as BatchResultLine;
    const key = parsed.key ?? null;
    const seed = key ? seeds.get(key) : null;

    if (!key || !seed) {
      failures.push({ key, reason: "Missing seed for batch result", line: parsed });
      continue;
    }

    if (parsed.response) {
      try {
        candidates.push(candidateFromResponse(seed, manifest.model, parsed.response));
      } catch (error) {
        failures.push({ key, reason: error instanceof Error ? error.message : String(error), line: parsed });
      }
      continue;
    }

    failures.push({ key, reason: "Batch result did not contain a response", line: parsed });
  }

  await Bun.$`mkdir -p ${dirname(manifest.outPath)}`;
  await Bun.write(
    manifest.outPath,
    candidates.length > 0 ? candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n" : ""
  );
  await Bun.write(
    manifest.failuresPath,
    failures.length > 0 ? failures.map((failure) => JSON.stringify(failure)).join("\n") + "\n" : ""
  );

  console.log(`Wrote ${candidates.length} candidate(s) to ${manifest.outPath}`);
  console.log(`Wrote ${failures.length} failure(s) to ${manifest.failuresPath}`);
}

function parseSubmitArgs(argv: string[]): SubmitArgs {
  const displayName = readFlag(argv, "--display-name") ?? `yori-ai-${timestampSlug()}`;

  return {
    inputPath: readFlag(argv, "--input") ?? "data/ai-seeds/zh-tw-seeds.jsonl",
    outPath: readFlag(argv, "--out") ?? "data/ai-candidates/zh-tw-candidates.jsonl",
    failuresPath: readFlag(argv, "--failures"),
    model: readFlag(argv, "--model") ?? process.env.GEMINI_MODEL ?? defaultGeminiModel,
    limit: readFlag(argv, "--limit") ? parsePositiveInt(readFlag(argv, "--limit") as string) : null,
    workDir: readFlag(argv, "--work-dir") ?? "data/ai-batches",
    displayName
  };
}

function parseCollectArgs(argv: string[]): CollectArgs {
  const manifestPath = readFlag(argv, "--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required");
  }

  return { manifestPath };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

async function uploadRequestFile(path: string, displayName: string, apiKey: string): Promise<string> {
  const file = Bun.file(path);
  const bytes = await file.arrayBuffer();
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(bytes.byteLength),
      "x-goog-upload-header-content-type": "application/jsonl"
    },
    body: JSON.stringify({ file: { display_name: displayName } })
  });

  if (!start.ok) {
    throw new Error(`Gemini file upload start failed: ${start.status} ${start.statusText} ${await start.text()}`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini file upload start did not return x-goog-upload-url");
  }

  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(bytes.byteLength),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize"
    },
    body: bytes
  });

  if (!finish.ok) {
    throw new Error(`Gemini file upload failed: ${finish.status} ${finish.statusText} ${await finish.text()}`);
  }

  const uploaded = (await finish.json()) as UploadedFile;
  if (!uploaded.file?.name) {
    throw new Error(`Gemini file upload returned no file name: ${JSON.stringify(uploaded)}`);
  }

  return uploaded.file.name;
}

async function createBatchJob(fileName: string, model: string, displayName: string, apiKey: string): Promise<string> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchGenerateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      batch: {
        display_name: displayName,
        input_config: {
          file_name: fileName
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini batch create failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  const batch = (await response.json()) as BatchResponse;
  if (!batch.name) {
    throw new Error(`Gemini batch create returned no batch name: ${JSON.stringify(batch)}`);
  }

  return batch.name;
}

async function getBatchJob(batchName: string, apiKey: string): Promise<BatchResponse> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
    headers: {
      "x-goog-api-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Gemini batch get failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  return (await response.json()) as BatchResponse;
}

async function downloadFile(fileName: string, apiKey: string): Promise<string> {
  const metadata = await getFile(fileName, apiKey);
  const downloadUri = metadata.downloadUri ?? `https://generativelanguage.googleapis.com/download/v1beta/${fileName}:download?alt=media`;
  const response = await fetch(downloadUri, {
    headers: {
      "x-goog-api-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Gemini file download failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  return await response.text();
}

async function getFile(fileName: string, apiKey: string): Promise<{ downloadUri?: string }> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
    headers: {
      "x-goog-api-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Gemini file get failed: ${response.status} ${response.statusText} ${await response.text()}`);
  }

  return (await response.json()) as { downloadUri?: string };
}

function batchState(batch: BatchResponse): string {
  if (typeof batch.state === "string") return batch.state;
  if (typeof batch.metadata?.state === "string") return batch.metadata.state;
  if (batch.done) return "DONE";
  return "UNKNOWN";
}

function isFailedState(state: string): boolean {
  return (
    state === "BATCH_STATE_FAILED" ||
    state === "BATCH_STATE_CANCELLED" ||
    state === "BATCH_STATE_EXPIRED" ||
    state === "JOB_STATE_FAILED" ||
    state === "JOB_STATE_CANCELLED" ||
    state === "JOB_STATE_EXPIRED" ||
    state === "FAILED"
  );
}

function isSucceededState(state: string): boolean {
  return state === "BATCH_STATE_SUCCEEDED" || state === "JOB_STATE_SUCCEEDED" || state === "SUCCEEDED";
}

function batchResultFileName(batch: BatchResponse): string | null {
  return (
    batch.dest?.fileName ??
    batch.dest?.file_name ??
    batch.response?.dest?.fileName ??
    batch.response?.dest?.file_name ??
    batch.response?.responsesFile ??
    batch.response?.responses_file ??
    null
  );
}

function timestampSlug(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}
