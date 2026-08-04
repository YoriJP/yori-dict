import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { downloadPinnedDataRelease } from "../scripts/download-data-release";

const sqliteBytes = Buffer.from("published sqlite bytes");
const gzipBytes = gzipSync(sqliteBytes);
const sha256 = createHash("sha256").update(gzipBytes).digest("hex");
let tempDir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  tempDir = await mkdtemp("/tmp/yori-dict-release-test-");
  server = Bun.serve({
    port: 0,
    fetch(request) {
      return /\/yori-dict-2026-07-01(?:\.1)?\.sqlite\.gz$/.test(new URL(request.url).pathname)
        ? new Response(gzipBytes)
        : new Response("not found", { status: 404 });
    }
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(tempDir, { recursive: true, force: true });
});

test("downloads, verifies, and expands the pinned public release artifact", async () => {
  const pinPath = join(tempDir, "valid-pin.json");
  const outPath = join(tempDir, "valid.sqlite");
  await writeFile(pinPath, JSON.stringify({ version: "2026-07-01.1", sha256 }));

  await downloadPinnedDataRelease({
    pinPath,
    outPath,
    releaseBaseUrl: server.url.toString().replace(/\/$/, "")
  });

  expect(await readFile(outPath)).toEqual(sqliteBytes);
});

test("rejects a checksum mismatch without replacing the current database", async () => {
  const pinPath = join(tempDir, "bad-pin.json");
  const outPath = join(tempDir, "current.sqlite");
  const currentBytes = Buffer.from("current verified database");
  await writeFile(pinPath, JSON.stringify({ version: "2026-07-01", sha256: "0".repeat(64) }));
  await writeFile(outPath, currentBytes);

  await expect(
    downloadPinnedDataRelease({
      pinPath,
      outPath,
      releaseBaseUrl: server.url.toString().replace(/\/$/, "")
    })
  ).rejects.toThrow("Checksum mismatch");

  expect(await readFile(outPath)).toEqual(currentBytes);
});
