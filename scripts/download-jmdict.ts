import { basename, dirname, join } from "node:path";
import { readdir, rename, rm } from "node:fs/promises";

type Release = {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

type Args = {
  outDir: string;
  tag: string;
};

const defaultReleaseTag = "3.6.2+20260601171836";
const args = parseArgs(Bun.argv.slice(2));
await Bun.$`mkdir -p ${args.outDir}`;

const release = await releaseByTag(args.tag);
const asset = release.assets.find((item) => /^jmdict-all-.+\.json\.tgz$/.test(item.name));

if (!asset) {
  throw new Error(`No jmdict-all JSON archive found in release ${release.tag_name}`);
}

const archivePath = join(args.outDir, asset.name);
const jsonPath = join(args.outDir, "jmdict-all.json");

console.log(`Downloading ${asset.name} from ${release.tag_name}`);
await download(asset.browser_download_url, archivePath);

await Bun.$`mkdir -p ${dirname(jsonPath)}`;
await Bun.$`tar -xzf ${archivePath} -C ${args.outDir}`;

const extractedName = await findExtractedJson(args.outDir, basename(jsonPath));
const extractedPath = join(args.outDir, extractedName);
if (extractedPath !== jsonPath) {
  await rm(jsonPath, { force: true });
  await rename(extractedPath, jsonPath);
}

console.log(`Wrote ${jsonPath}`);

function parseArgs(argv: string[]): Args {
  const outDir = readFlag(argv, "--out-dir") ?? "data/raw";
  const tag = readFlag(argv, "--tag") ?? process.env.JMDICT_SIMPLIFIED_TAG ?? defaultReleaseTag;
  return { outDir, tag };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function releaseByTag(tag: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/scriptin/jmdict-simplified/releases/tags/${tag}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "yori-dict-api"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub release request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as Release;
}

async function download(url: string, path: string) {
  await Bun.$`curl --fail --location --user-agent yori-dict-api --output ${path} ${url}`;
}

async function findExtractedJson(outDir: string, targetName: string): Promise<string> {
  const files = await readdir(outDir);
  const candidate = files.find((file) => /^jmdict-all-.+\.json$/.test(file) && file !== targetName);
  if (candidate) return candidate;
  if (files.includes(targetName)) return targetName;
  throw new Error(`No extracted jmdict-all JSON file found in ${outDir}`);
}
