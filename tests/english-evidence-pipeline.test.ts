import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnglishEvidenceArtifacts } from "../scripts/build-english-evidence";
import { ensureCachedArchive } from "../scripts/english-evidence-cache";
import { emptyCorroborationIndex, filterEnglishEvidence, type EvidenceRow } from "../scripts/english-evidence";

const fixtureLock = "fixtures/english-evidence/wiktionary-fixture-lock.json";
const fixtureArchive = "fixtures/english-evidence/en-extract-sample.jsonl";

test("filters a streamed archive into Japanese and Chinese evidence with a reproducible manifest", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);

  const manifest = await buildEnglishEvidenceArtifacts({
    lockPath: fixtureLock,
    archivePath: archive,
    outDir: join(workspace, "out"),
    maxRows: 500,
    maxRowsPerEntry: 24,
    allowDownload: false
  });

  expect(manifest.tool).toEqual({ name: "english-evidence-filter", version: "2.0.0" });
  expect(manifest.upstream).toMatchObject({
    source: "wiktionary",
    edition: "en",
    version: "2026-07-06",
    url: "https://kaikki.org/dictionary/downloads/en/en-extract.jsonl.gz",
    license: "CC-BY-SA-4.0 AND GFDL-1.1-or-later",
    attribution: "English Wiktionary contributors; extracted with Wiktextract"
  });
  expect(manifest.upstream.sha256).toBe(await sha256(archive));
  expect(manifest.upstream.compressedBytes).toBe((await stat(archive)).size);
  expect(manifest.mappedSources.map((source) => source.source)).toEqual(["japanese-wordnet", "taiwan-terminology"]);

  const rows = await readEvidence(join(workspace, "out", manifest.evidence.file));
  expect(rows).toHaveLength(manifest.evidence.rows);
  // The Japanese entry in the fixture is not an English headword.
  expect(rows.every((row) => row.sourcePage !== "犬")).toBe(true);
  // Every emitted row stays authoring evidence, never direct dictionary content.
  expect(rows.every((row) => row.role === "authoring-evidence" && row.directImportEligible === false)).toBe(true);

  expect(rows[0]).toEqual({
    evidenceId: "wiktionary-en:2026-07-06:dog:noun:1:0#senses[0].translations[0]",
    source: "wiktionary",
    sourceEdition: "en",
    sourceVersion: "2026-07-06",
    sourcePage: "dog",
    sourcePageId: 51419,
    sourceEntryId: "wiktionary-en:2026-07-06:dog:noun:1:0",
    sourceSenseId: "en-dog-en-noun-mammal",
    entryOrder: 0,
    pos: "noun",
    scope: "sense-local",
    senseIndex: 0,
    sourceGloss: "A mammal, Canis familiaris, that has been domesticated for thousands of years.",
    senseHint: null,
    translationLocation: "senses[0].translations",
    translationOrder: 0,
    targetLanguage: "ja",
    targetLocale: "ja",
    sourceLanguageCode: "ja",
    sourceLanguageName: "Japanese",
    targetTerm: "犬",
    targetRoman: "inu",
    qualifiers: [],
    taiwanSupport: false,
    corroboration: { source: "japanese-wordnet", version: "1.1", detail: "pwn-02084071-n/i46161" },
    ambiguous: false,
    ambiguityReasons: [],
    role: "authoring-evidence",
    directImportEligible: false
  });

  const entryLevel = row(rows, "ワンちゃん");
  expect(entryLevel).toMatchObject({
    scope: "entry-level",
    senseIndex: null,
    senseHint: "affectionate term",
    translationLocation: "translations",
    ambiguous: true,
    ambiguityReasons: ["entry-level-record-cannot-be-attributed-to-one-sense"]
  });

  // A free-text entry-level record whose sense text matches exactly one gloss
  // keeps that sense index while remaining entry-level.
  expect(row(rows, "犬", "zh")).toMatchObject({ scope: "entry-level", senseIndex: 0, targetLocale: "zh-hant" });
  expect(row(rows, "水, お水")).toMatchObject({ ambiguous: true, ambiguityReasons: ["multiple-terms-in-one-record"] });

  expect(manifest.coverage).toEqual({
    entriesRead: 5,
    englishEntries: 4,
    entriesWithEvidence: 4,
    rowsEmitted: 11,
    truncated: false,
    ja: {
      senseLocal: 4,
      entryLevel: 2,
      ambiguous: 3,
      corroborated: 2,
      unmatched: 4,
      rejected: 2,
      rejectionsByReason: { "missing-term": 1, "malformed-term": 1 }
    },
    zh: {
      senseLocal: 4,
      entryLevel: 1,
      ambiguous: 0,
      corroborated: 1,
      unmatched: 4,
      rejected: 1,
      rejectionsByReason: { "wrong-script": 1 }
    }
  });

  await rm(workspace, { recursive: true, force: true });
});

test("labels Taiwanese Chinese only where Taiwan terminology supports the term", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const manifest = await buildEnglishEvidenceArtifacts({
    lockPath: fixtureLock,
    archivePath: archive,
    outDir: join(workspace, "out"),
    maxRows: 500,
    maxRowsPerEntry: 24,
    allowDownload: false
  });
  const rows = await readEvidence(join(workspace, "out", manifest.evidence.file));

  expect(row(rows, "介面")).toMatchObject({
    targetLocale: "zh-tw",
    taiwanSupport: true,
    corroboration: { source: "taiwan-terminology", version: "2024-03", detail: "國家教育研究院/雙語詞彙、學術名詞暨辭書資訊網/資訊科技" }
  });
  // Traditional characters alone never become zh-tw.
  expect(row(rows, "狗")).toMatchObject({ targetLocale: "zh-hant", taiwanSupport: false, corroboration: null });
  expect(row(rows, "接口")).toMatchObject({ targetLocale: "zh-hans", taiwanSupport: false });

  await rm(workspace, { recursive: true, force: true });
});

test("repeats byte-identically for the same pinned archive and tool version", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const args = {
    lockPath: fixtureLock,
    archivePath: archive,
    maxRows: 500,
    maxRowsPerEntry: 24,
    allowDownload: false
  };

  const first = await buildEnglishEvidenceArtifacts({ ...args, outDir: join(workspace, "first") });
  const second = await buildEnglishEvidenceArtifacts({ ...args, outDir: join(workspace, "second") });

  expect(await sha256(join(workspace, "second", first.evidence.file))).toBe(
    await sha256(join(workspace, "first", first.evidence.file))
  );
  expect(await Bun.file(join(workspace, "second", "manifest.json")).text()).toBe(
    await Bun.file(join(workspace, "first", "manifest.json")).text()
  );
  expect(second.evidence.sha256).toBe(first.evidence.sha256);

  await rm(workspace, { recursive: true, force: true });
});

test("rejects an archive whose compressed checksum does not match the pinned value", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const lock = { ...(await Bun.file(fixtureLock).json()), sha256: "0".repeat(64) };
  const lockPath = join(workspace, "bad-lock.json");
  await writeFile(lockPath, JSON.stringify(lock));

  await expect(
    buildEnglishEvidenceArtifacts({
      lockPath,
      archivePath: archive,
      outDir: join(workspace, "out"),
      maxRows: 500,
      maxRowsPerEntry: 24,
      allowDownload: false
    })
  ).rejects.toThrow(/checksum mismatch/i);

  await rm(workspace, { recursive: true, force: true });
});

test("a failed run leaves the last verified evidence and manifest in place", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const outDir = join(workspace, "out");

  const good = await buildEnglishEvidenceArtifacts({
    lockPath: fixtureLock, archivePath: archive, outDir,
    maxRows: 500, maxRowsPerEntry: 24, allowDownload: false
  });
  const evidencePath = join(outDir, good.evidence.file);
  const verified = await sha256(evidencePath);
  const manifest = await Bun.file(join(outDir, "manifest.json")).text();

  // The checksum is only known once the whole archive has been read, so a
  // rejected rerun must not have replaced the artifact on its way there.
  const lock = { ...(await Bun.file(fixtureLock).json()), sha256: "0".repeat(64) };
  const lockPath = join(workspace, "bad-lock.json");
  await writeFile(lockPath, JSON.stringify(lock));
  await expect(
    buildEnglishEvidenceArtifacts({
      // A cap the good run did not use, so a run that wrote straight to the
      // artifact would leave visibly different content behind.
      lockPath, archivePath: archive, outDir,
      maxRows: 1, maxRowsPerEntry: 24, allowDownload: false
    })
  ).rejects.toThrow(/checksum mismatch/i);

  expect(await sha256(evidencePath)).toBe(verified);
  expect(await Bun.file(join(outDir, "manifest.json")).text()).toBe(manifest);
  expect(await Bun.file(`${evidencePath}.partial`).exists()).toBe(false);

  await rm(workspace, { recursive: true, force: true });
});

test("emits evidence while the archive is still being read", async () => {
  const lines = (await Bun.file(fixtureArchive).text()).split("\n").filter((line) => line.trim());
  const encoder = new TextEncoder();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${lines[pulls]}\n`));
      pulls += 1;
    }
  });

  const pullsWhenEmitted: number[] = [];
  const manifest = await filterEnglishEvidence(
    stream,
    {
      identity: {
        source: "wiktionary",
        edition: "en",
        version: "test",
        url: "https://example.invalid/en-extract.jsonl",
        license: "CC-BY-SA-4.0",
        attribution: "English Wiktionary contributors",
        expectedSha256: null,
        http: null
      },
      evidenceFileName: "evidence.jsonl",
      gzip: false,
      maxRows: 500,
      maxRowsPerEntry: 24,
      corroboration: emptyCorroborationIndex
    },
    () => {
      pullsWhenEmitted.push(pulls);
    }
  );

  expect(manifest.evidence.rows).toBe(11);
  expect(pullsWhenEmitted[0]).toBeLessThan(lines.length);
});

test("caps the filtered artifact while still checksumming the whole archive", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const manifest = await buildEnglishEvidenceArtifacts({
    lockPath: fixtureLock,
    archivePath: archive,
    outDir: join(workspace, "out"),
    maxRows: 3,
    maxRowsPerEntry: 24,
    allowDownload: false
  });

  expect(manifest.coverage.truncated).toBe(true);
  expect(manifest.evidence.rows).toBe(3);
  expect(manifest.coverage.entriesRead).toBe(5);
  expect(manifest.upstream.sha256).toBe(await sha256(archive));

  await rm(workspace, { recursive: true, force: true });
});

test("resumes a partial archive download into an ignored cache", async () => {
  const workspace = await workspaceDirectory();
  const archive = await gzipFixture(workspace);
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const rangeRequests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const range = request.headers.get("range");
      if (!range) return new Response(bytes, { headers: { etag: '"pinned"' } });
      rangeRequests.push(range);
      const start = Number.parseInt(range.replace("bytes=", "").split("-")[0] ?? "0", 10);
      return new Response(bytes.slice(start), {
        status: 206,
        headers: {
          etag: '"pinned"',
          "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`
        }
      });
    }
  });

  try {
    const cachePath = join(workspace, "cache", "en-extract.jsonl.gz");
    await Bun.write(`${cachePath}.part`, bytes.slice(0, 64));

    const resumed = await ensureCachedArchive(server.url.href, cachePath, { now: () => "2026-08-08T00:00:00.000Z" });
    expect(rangeRequests).toEqual(["bytes=64-"]);
    expect(resumed.fromCache).toBe(false);
    expect(resumed.http).toMatchObject({ status: 206, etag: '"pinned"', contentLength: bytes.length });
    expect(await sha256(cachePath)).toBe(await sha256(archive));

    const reused = await ensureCachedArchive(server.url.href, cachePath, { now: () => "2026-08-09T00:00:00.000Z" });
    expect(reused.fromCache).toBe(true);
    expect(reused.http.retrievedAt).toBe("2026-08-08T00:00:00.000Z");
    expect(rangeRequests).toHaveLength(1);
  } finally {
    await server.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("keeps the upstream archive cache out of git", async () => {
  const ignored = await Bun.$`git check-ignore data/wiktionary/en-extract-2026-07-06.jsonl.gz`.text();
  expect(ignored.trim()).toBe("data/wiktionary/en-extract-2026-07-06.jsonl.gz");

  const tracked = await Bun.$`git ls-files sources/english/evidence data/wiktionary`.text();
  expect(tracked.trim()).toBe("");
});

function row(rows: EvidenceRow[], term: string, language?: "ja" | "zh"): EvidenceRow {
  const found = rows.find((candidate) => candidate.targetTerm === term && (!language || candidate.targetLanguage === language));
  if (!found) throw new Error(`No evidence row for ${term}`);
  return found;
}

async function readEvidence(path: string): Promise<EvidenceRow[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvidenceRow);
}

async function gzipFixture(workspace: string): Promise<string> {
  const path = join(workspace, "en-extract.jsonl.gz");
  const text = await Bun.file(fixtureArchive).text();
  await Bun.write(path, Bun.gzipSync(new TextEncoder().encode(text)));
  return path;
}

async function workspaceDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yori-english-evidence-"));
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}
