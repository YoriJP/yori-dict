import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { dataReleaseRepository } from "../src/data-release";

type DataReleasePin = {
  version: string;
  sha256: string;
};

type DownloadOptions = {
  pinPath?: string;
  outPath?: string;
  releaseBaseUrl?: string;
};

export async function downloadPinnedDataRelease(options: DownloadOptions = {}): Promise<void> {
  const pinPath = options.pinPath ?? "data-release.json";
  const outPath = options.outPath ?? "data/yori.sqlite";
  const pin = await readPin(pinPath);
  const artifactName = `yori-dict-${pin.version}.sqlite.gz`;
  const releaseBaseUrl = options.releaseBaseUrl ??
    `https://github.com/${dataReleaseRepository}/releases/download/data-${pin.version}`;
  const artifactUrl = `${releaseBaseUrl}/${artifactName}`;
  const tempSuffix = `${process.pid}-${Date.now()}`;
  const sqlitePath = resolve(`${outPath}.${tempSuffix}.tmp`);

  await mkdir(dirname(resolve(outPath)), { recursive: true });

  try {
    console.log(`Downloading ${artifactUrl}`);
    const response = await fetch(artifactUrl);
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}: ${artifactUrl}`);
    }
    if (!response.body) {
      throw new Error(`Download returned an empty response body: ${artifactUrl}`);
    }

    const hash = createHash("sha256");
    const checksumStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(
      response.body,
      checksumStream,
      createGunzip(),
      createWriteStream(sqlitePath)
    );

    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== pin.sha256) {
      throw new Error(
        `Checksum mismatch for ${artifactName}: expected ${pin.sha256}, got ${actualSha256}`
      );
    }

    console.log(`Verified SHA-256 ${actualSha256}`);
    await rename(sqlitePath, outPath);
    console.log(`Wrote ${outPath}`);
  } finally {
    await rm(sqlitePath, { force: true });
  }
}

async function readPin(path: string): Promise<DataReleasePin> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read data release pin ${path}`, { cause: error });
  }

  if (!value || typeof value !== "object") {
    throw new Error(`Invalid data release pin ${path}: expected a JSON object`);
  }

  const pin = value as Partial<DataReleasePin>;
  if (typeof pin.version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pin.version)) {
    throw new Error(`Invalid data release pin ${path}: version must use YYYY-MM-DD`);
  }
  if (typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256)) {
    throw new Error(`Invalid data release pin ${path}: sha256 must be 64 lowercase hex characters`);
  }

  return { version: pin.version, sha256: pin.sha256 };
}

if (import.meta.main) {
  await downloadPinnedDataRelease();
}
