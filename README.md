# Yori Dict API

Small Japanese dictionary API built from JMdict-simplified.

Code is licensed under MIT. Dictionary data and release SQLite artifacts are
licensed under CC BY-SA 4.0. See [DATA_SOURCES.md](DATA_SOURCES.md).

## v0 scope

- Import a JMdict-simplified JSON file into SQLite.
- Serve frontend-ready lookup responses.
- Support exact lookup by writing or reading.
- Support basic word-level deinflection.
- Support single and batch lookup.
- Import reviewed AI-assisted Traditional Chinese glosses.

## Commands

```sh
bun install
bun run download:jmdict
bun run build:db
bun run dev
```

Then:

```sh
curl 'http://localhost:3000/v1/lookup?q=食べました&lang=zh-tw'
```

## Full JMdict Data

The repo keeps the small fixture in git for tests. Full JMdict-simplified data is downloaded into ignored local files:

```sh
bun run download:jmdict
bun run build:db
bun run lookup:check
```

This creates:

```txt
data/raw/jmdict-all.json
data/yori.sqlite
```

Both are local generated data and are not committed.

The reviewed zh-TW AI gloss source is committed at:

```txt
sources/ai-glosses/zh-tw.jsonl
```

To prepare a release SQLite artifact:

```sh
bun run download:jmdict
bun run release:package
```

This writes ignored release files under `releases/`:

```txt
releases/yori-dict-<dictDate>.sqlite
releases/yori-dict-<dictDate>.sqlite.gz
releases/yori-dict-<dictDate>.sqlite.gz.sha256
releases/yori-dict-<dictDate>.json
```

Upload the `.sqlite.gz`, `.sha256`, and `.json` files as release artifacts. Users can decompress the SQLite file and use it directly.

For Railway, use a build command that creates the DB before the server starts:

```sh
bun install
bun run download:jmdict
bun run build:db
```

Set the start command to:

```sh
bun run start
```

The server reads `YORI_DB_PATH`, defaulting to `data/yori.sqlite`.

GitHub Actions deploys to Railway on pushes to `main` and by manual workflow
dispatch. Add this GitHub repository secret:

```txt
RAILWAY_TOKEN
```

Use a Railway Project Token for `RAILWAY_TOKEN`. If the Railway project has
multiple services or environments, also add these optional GitHub repository
variables:

```txt
RAILWAY_SERVICE
RAILWAY_ENVIRONMENT
```

Railway build and deploy settings are defined in [railway.json](railway.json).

## AI Seeds

Export a small local JSONL file of English JMdict senses that are missing a target language:

```sh
bun run ai:seeds -- --lang zh-tw --limit 20
```

Generate local AI candidates from those seeds:

```sh
GEMINI_API_KEY=... bun run ai:generate -- --limit 20
```

Use the Batch API for larger offline runs:

```sh
bun run ai:batch -- submit --limit 1000
```

The submit command writes a manifest under `data/ai-batches/`. When the batch finishes, collect the results with the manifest path printed by submit:

```sh
bun run ai:batch -- collect --manifest data/ai-batches/<run>/manifest.json
```

Check candidates into a committed source file:

```sh
bun run ai:accept -- --input data/ai-candidates/zh-tw-candidates.jsonl --out sources/ai-glosses/zh-tw.jsonl --append
```

Rejected rows are written under `data/ai-candidates/` by default. After editing or agent review, rebuild SQLite with accepted glosses:

```sh
bun run ai:validate -- --input sources/ai-glosses/zh-tw.jsonl
bun run import:jmdict:full -- --ai-glosses sources/ai-glosses/zh-tw.jsonl
```

Prepare a small bundle for CLI/agent review of AI-generated glosses:

```sh
bun run ai:review -- --lang zh-tw --limit 500 --common-only
bun run ai:review -- --lang zh-tw --limit 500 --offset 500 --common-only
```

If a Batch result has failures, export only those failed seeds for a rerun:

```sh
bun run ai:summary -- --manifest data/ai-batches/<run>/manifest.json
bun run ai:retry-seeds -- --manifest data/ai-batches/<run>/manifest.json --out data/ai-seeds/failed-seeds.jsonl
bun run ai:batch -- submit --input data/ai-seeds/failed-seeds.jsonl
```

Generated files under `data/` are ignored. Accepted and reviewed gloss source files under `sources/` are committed.

## API

```txt
GET /health
GET /v1/meta
GET /v1/lookup?q=食べる&lang=zh-tw
POST /v1/lookup/batch
```

`lang` defaults to `en`. Lookup returns glosses only for the requested language; it does not fall back to English when that language has no glosses.
Senses with no glosses in the requested language are omitted from the response.

Batch request:

```json
{
  "queries": ["食べました", "学校"],
  "lang": "zh-tw"
}
```

## Data

The importer currently uses a small fixture:

```sh
bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out data/yori.sqlite
```

Full JMdict-simplified import can use the same command with a downloaded full JSON file. Add `--ai-glosses sources/ai-glosses/zh-tw.jsonl` to include reviewed zh-TW glosses in the local SQLite database.
