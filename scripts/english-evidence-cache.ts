import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { HttpMetadata } from "./english-evidence";

export type CachedArchive = {
  path: string;
  http: HttpMetadata;
  fromCache: boolean;
};

export type CacheOptions = {
  fetch?: typeof fetch;
  now?: () => string;
};

/**
 * Downloads the upstream archive into an ignored resumable cache. The archive
 * is never committed: the cache path lives under an ignored data directory and
 * a partial download resumes with an HTTP range request instead of restarting.
 */
export async function ensureCachedArchive(
  url: string,
  cachePath: string,
  options: CacheOptions = {}
): Promise<CachedArchive> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const metaPath = `${cachePath}.meta.json`;
  const partPath = `${cachePath}.part`;

  await mkdir(dirname(cachePath), { recursive: true });

  const cached = await readCacheMetadata(metaPath);
  if (cached && (await fileSize(cachePath)) === cached.contentLength) {
    return { path: cachePath, http: cached, fromCache: true };
  }

  const resumeFrom = await fileSize(partPath);
  const response = await doFetch(url, {
    headers: resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {}
  });
  if (!response.ok) {
    throw new Error(`Archive download failed: ${response.status} ${response.statusText}`);
  }
  if (resumeFrom > 0 && response.status !== 206) {
    // The server ignored the range request, so the partial file is unusable.
    await rm(partPath, { force: true });
  }
  if (!response.body) throw new Error("Archive download returned no body");

  const append = resumeFrom > 0 && response.status === 206;
  const handle = await open(partPath, append ? "a" : "w");
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }

  await rm(cachePath, { force: true });
  await rename(partPath, cachePath);

  const http: HttpMetadata = {
    url,
    status: response.status,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    contentLength: await fileSize(cachePath),
    contentType: response.headers.get("content-type"),
    retrievedAt: now()
  };
  await Bun.write(metaPath, `${JSON.stringify(http, null, 2)}\n`);
  return { path: cachePath, http, fromCache: false };
}

export async function readCacheMetadata(metaPath: string): Promise<HttpMetadata | null> {
  const file = Bun.file(metaPath);
  if (!(await file.exists())) return null;
  return (await file.json()) as HttpMetadata;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
