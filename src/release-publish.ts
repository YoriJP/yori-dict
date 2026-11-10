import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildEnglishRelease } from "./english-release";
import { buildJapaneseRelease } from "./japanese-release";

export type ReleaseDictionary = "en" | "ja";

type Manifest = {
  entries: number;
  coverage: Record<string, { entries: number; senses: number; examples: number }>;
  levels?: Record<string, number>;
};
type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  upload_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
};

const products = {
  en: { build: buildEnglishRelease, tagPrefix: "english-", title: "Yori English" },
  ja: { build: buildJapaneseRelease, tagPrefix: "data-", title: "Yori Japanese" }
} as const;

const languageNames: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  "zh-cn": "Simplified Chinese",
  "zh-tw": "Taiwanese Traditional Chinese"
};

export type PublishReleaseOptions = {
  dictionary: ReleaseDictionary;
  version: string;
  databasePath: string;
  /** Scratch space for the artifacts; removed after upload. */
  workDirectory: string;
  repository: string;
  token: string;
  /** Commit the tag points at once the draft is published. */
  target: string;
  apiUrl?: string;
  /** A source removal can legitimately shrink a dictionary; otherwise a drop means a broken import. */
  allowFewerEntries?: boolean;
};

/**
 * Exports one dictionary from the production database and uploads it as a
 * draft GitHub release. The draft body compares coverage with the previous
 * published release; a maintainer writes the notes and publishes it.
 */
export async function publishDraftRelease(options: PublishReleaseOptions): Promise<{ url: string; tag: string }> {
  const product = products[options.dictionary];
  const tag = `${product.tagPrefix}${options.version}`;
  const github = gitHubClient(options);

  const releases = await github.json<GitHubRelease[]>(`/repos/${options.repository}/releases?per_page=100`);
  if (releases.some((release) => release.tag_name === tag)) {
    throw new Error(`A release or draft for ${tag} already exists`);
  }
  const previous = releases.find((release) =>
    !release.draft && !release.prerelease && release.tag_name.startsWith(product.tagPrefix)
  ) ?? null;

  const directory = await mkdtemp(join(options.workDirectory, `${tag}-`));
  try {
    const artifacts = await product.build(options.databasePath, { outputDirectory: directory, version: options.version });
    const manifest = await Bun.file(artifacts.manifest).json() as Manifest;
    const previousManifest = previous ? await github.asset<Manifest>(previous, (name) => name.endsWith(".json")) : null;
    if (previousManifest && manifest.entries < previousManifest.entries && !options.allowFewerEntries) {
      throw new Error(
        `${tag} has ${manifest.entries} entries, fewer than ${previous!.tag_name} (${previousManifest.entries}). ` +
          "Pass --allow-fewer-entries if a source removal explains it."
      );
    }

    const draft = await github.json<GitHubRelease>(`/repos/${options.repository}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: options.target,
        name: `${product.title} ${options.version}`,
        body: coverageSummary(manifest, previous?.tag_name ?? null, previousManifest),
        draft: true
      })
    });
    const uploadUrl = draft.upload_url.replace(/\{.*\}$/, "");
    for (const path of [
      artifacts.sqlite, artifacts.gzip, artifacts.checksum, artifacts.jsonl, artifacts.manifest,
      ...Object.values(artifacts.yomitan)
    ]) {
      await github.json(`${uploadUrl}?name=${encodeURIComponent(basename(path))}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Bun.file(path)
      });
    }
    return { url: draft.html_url, tag };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function coverageSummary(manifest: Manifest, previousTag: string | null, previous: Manifest | null): string {
  const change = (now: number, before: number | undefined) =>
    before === undefined || before === now ? "" : ` (${now > before ? "+" : ""}${(now - before).toLocaleString("en-US")})`;
  const rows = Object.entries(manifest.coverage).map(([lang, now]) => {
    const before = previous?.coverage[lang];
    return `| ${languageNames[lang] ?? lang} | ${now.entries.toLocaleString("en-US")}${change(now.entries, before?.entries)} ` +
      `| ${now.senses.toLocaleString("en-US")}${change(now.senses, before?.senses)} ` +
      `| ${now.examples.toLocaleString("en-US")}${change(now.examples, before?.examples)} |`;
  });
  return [
    `${manifest.entries.toLocaleString("en-US")} entries${change(manifest.entries, previous?.entries)}` +
      (previousTag ? `, compared with ${previousTag}.` : "."),
    "",
    "| Definition language | Entries | Senses | Examples |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    ...(manifest.levels
      ? ["", `Estimated levels: ${Object.entries(manifest.levels).map(([level, count]) => `${level} ${count.toLocaleString("en-US")}`).join(", ")}.`]
      : [])
  ].join("\n");
}

function gitHubClient(options: PublishReleaseOptions) {
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(path.startsWith("http") ? path : `${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    return response;
  };
  return {
    json: async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>,
    // Published assets are public; the download redirects to storage that rejects the API token.
    asset: async <T>(release: GitHubRelease, match: (name: string) => boolean) => {
      const asset = release.assets.find(({ name }) => match(name));
      if (!asset) return null;
      const response = await fetch(asset.browser_download_url);
      if (!response.ok) throw new Error(`Downloading ${asset.name} failed: ${response.status}`);
      return response.json() as Promise<T>;
    }
  };
}
