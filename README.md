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
bun run lookup:check
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

Lookup returns one best item:

```json
{
  "item": {
    "id": "yori:e_jmdict_1358280",
    "word": "食べる",
    "reading": "たべる",
    "common": true,
    "matchedFrom": {
      "input": "食べました",
      "form": "食べる",
      "type": "deinflected",
      "reasons": ["polite past"]
    },
    "senses": [
      {
        "partOfSpeech": ["v1", "vt"],
        "glosses": {
          "zh-tw": [],
          "en": [{ "text": "to eat", "source": "jmdict", "reviewStatus": "source" }]
        }
      }
    ]
  }
}
```

Batch request:

```json
{
  "queries": ["食べました", "学校"],
  "lang": "zh-tw"
}
```

Batch lookup returns one result per input:

```json
{
  "results": [
    { "input": "食べました", "item": {} },
    { "input": "存在しない語", "item": null }
  ]
}
```

## Data

The importer currently uses a small fixture:

```sh
bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out data/yori.sqlite
```

Full JMdict-simplified import can use the same command with a downloaded full JSON file.
