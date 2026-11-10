import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildEnglishDictionary } from "../src/english-rebuild";
import { importEnglishRelease, migrateProductionDatabase } from "../src/production-database";
import { publishDraftRelease } from "../src/release-publish";
import { fixtureWordNet, levelSources } from "./english-level-fixtures";

type Recorded = { created: Array<Record<string, unknown>>; uploads: Map<string, Uint8Array> };
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

test("a release uploads every exported artifact to a draft compared with the last published release", async () => {
  const { production, root } = await productionWithLevels();
  const github = fakeGitHub([
    release("english-2026.12.0-rc", { prerelease: true, entries: 1 }),
    release("data-2026-10-06", { entries: 200_000 }),
    release("english-2026.10.1", { entries: 3 })
  ]);
  const workDirectory = mkdtempSync(join(root, "work-"));

  const draft = await publishDraftRelease({
    dictionary: "en",
    version: "2026.10.2",
    databasePath: production,
    workDirectory,
    repository: "YoriJP/yori-dict",
    token: "test-token",
    target: "abc123",
    apiUrl: github.url
  });

  expect(draft.tag).toBe("english-2026.10.2");
  expect(github.recorded.created).toEqual([expect.objectContaining({
    tag_name: "english-2026.10.2",
    target_commitish: "abc123",
    draft: true
  })]);
  // Compared with the last published English release, not a prerelease or the Japanese line.
  expect(String(github.recorded.created[0]!.body)).toContain("english-2026.10.1");

  const uploaded = github.recorded.uploads;
  const manifest = JSON.parse(new TextDecoder().decode(uploaded.get("yori-english-2026.10.2.json")!));
  expect([...uploaded.keys()].sort()).toEqual([
    manifest.artifact, manifest.checksum, manifest.jsonl, "yori-english-2026.10.2.json",
    "yori-english-2026.10.2.sqlite", ...Object.values(manifest.yomitan)
  ].sort());
  expect(manifest.levels).toEqual({ A1: 2, C1: 1 });
  expect(readdirSync(workDirectory)).toEqual([]);
});

test("a release with fewer entries than the last one, or an existing tag, creates nothing", async () => {
  const { production, root } = await productionWithLevels();
  const options = {
    dictionary: "en" as const,
    databasePath: production,
    workDirectory: mkdtempSync(join(root, "work-")),
    repository: "YoriJP/yori-dict",
    token: "test-token",
    target: "abc123"
  };

  const shrunk = fakeGitHub([release("english-2026.10.1", { entries: 100 })]);
  await expect(publishDraftRelease({ ...options, version: "2026.10.2", apiUrl: shrunk.url })).rejects.toThrow("fewer");
  expect(shrunk.recorded.created).toEqual([]);
  expect(readdirSync(options.workDirectory)).toEqual([]);

  const existing = fakeGitHub([release("english-2026.10.2", { entries: 3, draft: true })]);
  await expect(publishDraftRelease({ ...options, version: "2026.10.2", apiUrl: existing.url })).rejects.toThrow("already exists");
  expect(existing.recorded.created).toEqual([]);
});

async function productionWithLevels() {
  const root = mkdtempSync(join(tmpdir(), "yori-release-publish-"));
  const production = join(root, "yori.sqlite");
  migrateProductionDatabase(production);
  const rebuilt = await rebuildEnglishDictionary({
    sources: [await fixtureWordNet(root)],
    levelSources: await levelSources(root),
    out: join(root, "english.sqlite"),
    version: "2026.10.2",
    retainFrom: null
  });
  importEnglishRelease(production, rebuilt.path);
  return { production, root };
}

function release(tag: string, options: { entries: number; draft?: boolean; prerelease?: boolean }) {
  return { tag, entries: options.entries, draft: options.draft ?? false, prerelease: options.prerelease ?? false };
}

function fakeGitHub(releases: Array<ReturnType<typeof release>>) {
  const recorded: Recorded = { created: [], uploads: new Map() };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (request.method === "GET" && url.pathname === "/repos/YoriJP/yori-dict/releases") {
        return Response.json(releases.map((item) => ({
          tag_name: item.tag,
          draft: item.draft,
          prerelease: item.prerelease,
          html_url: `${origin}/${item.tag}`,
          upload_url: `${origin}/upload/${item.tag}{?name,label}`,
          assets: [{ name: `${item.tag}.json`, browser_download_url: `${origin}/download/${item.tag}` }]
        })));
      }
      if (url.pathname.startsWith("/download/")) {
        const item = releases.find(({ tag }) => tag === url.pathname.slice("/download/".length))!;
        return Response.json({ entries: item.entries, coverage: { en: { entries: item.entries, senses: item.entries, examples: 0 } } });
      }
      if (request.method === "POST" && url.pathname === "/repos/YoriJP/yori-dict/releases") {
        const body = await request.json() as Record<string, unknown>;
        recorded.created.push(body);
        return Response.json({
          ...body,
          html_url: `${origin}/draft`,
          upload_url: `${origin}/upload/draft{?name,label}`,
          assets: []
        }, { status: 201 });
      }
      if (request.method === "POST" && url.pathname === "/upload/draft") {
        recorded.uploads.set(url.searchParams.get("name")!, new Uint8Array(await request.arrayBuffer()));
        return Response.json({}, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }
  });
  servers.push(server);
  return { url: server.url.origin, recorded };
}
