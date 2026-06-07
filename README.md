# Yori Dict API

Small Japanese dictionary API built from JMdict-simplified.

## v0 scope

- Import a JMdict-simplified JSON file into SQLite.
- Serve frontend-ready lookup responses.
- Support exact lookup by writing or reading.
- Support basic word-level deinflection.
- Support single and batch lookup.

AI enrichment is intentionally out of scope for v0.

## Commands

```sh
bun install
bun run import:jmdict
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
bun run import:jmdict:full
```

This creates:

```txt
data/raw/jmdict-all.json
data/yori.sqlite
```

Both are local generated data and are not committed.

## API

```txt
GET /health
GET /v1/meta
GET /v1/lookup?q=食べる&lang=zh-tw
POST /v1/lookup/batch
```

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

Full JMdict-simplified import can use the same command with a downloaded full JSON file.
