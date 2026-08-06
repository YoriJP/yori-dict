import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

type Args = {
  dbPath: string;
  outDir: string;
  version: string | null;
};

type CountRow = {
  count: number;
};

const args = parseArgs(Bun.argv.slice(2));
const dbFile = Bun.file(args.dbPath);

if (!(await dbFile.exists())) {
  throw new Error(`SQLite database does not exist: ${args.dbPath}`);
}

await mkdir(args.outDir, { recursive: true });

const metadata = readDbMetadata(args.dbPath);
const artifactVersion = args.version ?? metadata.dictionaryVersion ?? "unknown";
const baseName = `yori-dict-${artifactVersion}`;
const sqliteArtifact = join(args.outDir, `${baseName}.sqlite`);
const gzipArtifact = `${sqliteArtifact}.gz`;
const checksumPath = `${gzipArtifact}.sha256`;
const manifestPath = join(args.outDir, `${baseName}.json`);

await rm(sqliteArtifact, { force: true });
await rm(gzipArtifact, { force: true });
await rm(checksumPath, { force: true });
await rm(manifestPath, { force: true });

await Bun.write(sqliteArtifact, dbFile);
await pipeline(createReadStream(sqliteArtifact), createGzip({ level: 9 }), createWriteStream(gzipArtifact));

const sqliteStats = await stat(sqliteArtifact);
const gzipStats = await stat(gzipArtifact);
const sha256 = await fileSha256(gzipArtifact);

await writeFile(checksumPath, `${sha256}  ${basename(gzipArtifact)}\n`);
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      artifact: basename(gzipArtifact),
      checksum: basename(checksumPath),
      sha256,
      sqliteBytes: sqliteStats.size,
      gzipBytes: gzipStats.size,
      artifactVersion,
      dictionaryVersion: metadata.dictionaryVersion,
      jmdictSimplifiedVersion: metadata.jmdictSimplifiedVersion,
      counts: metadata.counts,
      sources: [
        {
          name: "JMdict",
          license: "CC-BY-SA-4.0",
          url: "https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project"
        },
        {
          name: "Tatoeba example sentences",
          license: "CC-BY-2.0-FR",
          url: "https://tatoeba.org/en/terms_of_use"
        },
        {
          name: "yomitan-jlpt-vocab",
          license: "CC-BY-SA-4.0",
          url: "https://github.com/stephenmk/yomitan-jlpt-vocab"
        },
        {
          name: "Yori generated zh-TW glosses (legacy records)",
          license: "CC-BY-SA-4.0",
          path: "sources/ai-glosses/zh-tw.jsonl"
        },
        {
          name: "Yori generated zh-CN glosses (legacy records)",
          license: "CC-BY-SA-4.0",
          path: "sources/ai-glosses/zh-cn.jsonl"
        },
        {
          name: "Yori generated Korean glosses (legacy records)",
          license: "CC-BY-SA-4.0",
          path: "sources/ai-glosses/ko.jsonl"
        },
        {
          name: "Yori generated examples",
          license: "CC-BY-SA-4.0",
          path: "sources/ai-examples/generated.jsonl"
        }
      ]
    },
    null,
    2
  ) + "\n"
);

console.log(`Wrote ${sqliteArtifact}`);
console.log(`Wrote ${gzipArtifact}`);
console.log(`Wrote ${checksumPath}`);
console.log(`Wrote ${manifestPath}`);

function parseArgs(argv: string[]): Args {
  return {
    dbPath: readFlag(argv, "--db") ?? "data/yori.sqlite",
    outDir: readFlag(argv, "--out-dir") ?? "releases",
    version: readFlag(argv, "--version")
  };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function readDbMetadata(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      dictionaryVersion: readMetadata(db, "dictDate"),
      jmdictSimplifiedVersion: readMetadata(db, "jmdictSimplifiedVersion"),
      counts: {
        entries: readCount(db, "select count(*) as count from entries"),
        senses: readCount(db, "select count(*) as count from senses"),
        glosses: readCount(db, "select count(*) as count from glosses"),
        generatedLegacyGlosses: readCount(
          db,
          "select count(*) as count from glosses where source = 'ai-assisted'"
        ),
        sourcedExamples: readCount(db, "select count(*) as count from examples where source = 'sourced'"),
        generatedExamples: readCount(db, "select count(*) as count from examples where source = 'generated'"),
        estimatedLevels: readCount(
          db,
          "select count(*) as count from entries where estimated_level is not null"
        )
      }
    };
  } finally {
    db.close();
  }
}

function readMetadata(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("select value from metadata where key = ?").get(key);
  return row?.value ?? null;
}

function readCount(db: Database, sql: string): number {
  const row = db.query<CountRow, []>(sql).get();
  return row?.count ?? 0;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
