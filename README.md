# Yori Dict

Open Japanese dictionary API and SQLite database with multilingual lookup support.

Code is licensed under MIT. Dictionary data and SQLite release files are
licensed under CC BY-SA 4.0. See [DATA_SOURCES.md](DATA_SOURCES.md).

## Public Use

Public API:

```txt
https://yori-dict-production.up.railway.app
```

API docs are hosted at:

```txt
https://yori-dict-production.up.railway.app/doc
```

The raw OpenAPI file is available at:

```txt
https://yori-dict-production.up.railway.app/openapi.yaml
```

```sh
curl 'https://yori-dict-production.up.railway.app/'
curl 'https://yori-dict-production.up.railway.app/health'
curl 'https://yori-dict-production.up.railway.app/v1/meta'
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&lang=zh-tw'
curl -X POST 'https://yori-dict-production.up.railway.app/v1/lookup/batch' \
  -H 'content-type: application/json' \
  --data '{"queries":["食べました","学校","孑々"],"lang":"zh-tw"}'
```

SQLite data release:

```txt
https://github.com/anilahsu/yori-dict/releases/tag/data-2026-06-10
```

Download and verify the SQLite database:

```sh
curl -LO https://github.com/anilahsu/yori-dict/releases/download/data-2026-06-10/yori-dict-2026-06-10.sqlite.gz
curl -LO https://github.com/anilahsu/yori-dict/releases/download/data-2026-06-10/yori-dict-2026-06-10.sqlite.gz.sha256
shasum -a 256 -c yori-dict-2026-06-10.sqlite.gz.sha256
gunzip yori-dict-2026-06-10.sqlite.gz
```

## v0 scope

- Import a JMdict-simplified JSON file into SQLite.
- Serve frontend-ready lookup responses.
- Support exact lookup by writing or reading.
- Support basic word-level deinflection.
- Support single and batch lookup.
- Import reviewed AI-assisted Traditional Chinese and Korean glosses.

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

`download:jmdict` defaults to the JMdict-simplified release that the reviewed
AI gloss source was built against: `3.6.2+20260601171836`. To intentionally
refresh to a different upstream release, pass `--tag` or set
`JMDICT_SIMPLIFIED_TAG`, then revalidate/review affected AI gloss rows.

This creates:

```txt
data/raw/jmdict-all.json
data/yori.sqlite
```

Both are local generated data and are not committed.

Reviewed AI gloss sources are committed under:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/ko.jsonl
```

To prepare a release SQLite artifact:

```sh
bun run download:jmdict
bun run release:check
bun run scripts/package-release.ts --version 2026-06-10
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

Railway build and deploy settings are defined in [railway.json](railway.json).
Use Railway's GitHub integration to autodeploy this repository.

## AI-Assisted Gloss Pipeline

Some target-language glosses are generated with AI because JMdict does not
provide complete coverage for every language Yori Dict wants to support. AI is
used only as a translation aid for existing JMdict senses. It does not create
new dictionary entries or new senses.

Each generated row starts from one JMdict sense:

```txt
Japanese word + reading + part of speech + English source glosses
```

The current generator uses `gemini-3-flash-preview` with thinking level `low`.
The prompt asks for short dictionary glosses in the target language and JSON
only:

```txt
Translate one JMdict Japanese sense into <target language> dictionary glosses.
Return JSON only with this shape: {"glosses":["..."]}.
Do not add examples.
Do not add a new sense.
Preserve the meaning of the English source glosses.
```

The raw AI result is not imported directly. It goes through this pipeline:

```txt
JMdict sense -> AI candidate -> mechanical filter -> CLI/agent review -> committed source -> SQLite build
```

`ai:filter` performs deterministic checks before a row can enter `sources/`:

- the `senseId` must exist in the current JMdict SQLite database
- the target language must match the requested language
- the sense must not already have glosses in that language
- duplicate source rows are rejected
- empty, duplicated, too long, or sentence-like glosses are rejected
- Chinese glosses must contain Han text and avoid suspicious Latin text
- Korean glosses must contain Hangul and must not contain Japanese kana

Rows rejected by the filter stay under ignored `data/ai-candidates/` files for
inspection or later retry. Filtered rows are still treated as untrusted until
they are reviewed.

`ai:review` writes a JSONL review bundle for a CLI or agent reviewer. Each row
contains the AI glosses plus the original JMdict context:

```txt
senseId, word, reading, part of speech, English glosses, AI glosses
```

The reviewer is asked to flag only suspicious rows as JSONL issues. Typical
issues are wrong sense, overly broad gloss, hallucinated word, malformed target
language, or a gloss that belongs to a neighboring sense. Flagged rows are
edited or removed before commit.

Committed AI-assisted gloss rows use:

```json
{"source":"ai-assisted","model":"gemini-3-flash-preview"}
```

When imported into SQLite, they are marked as `ai-assisted` and `checked`.
This means the row passed deterministic validation and CLI/agent review. It
does not mean it is perfect or native-speaker certified. If you find a bad
gloss, please open an issue with the word, language, and expected correction.

## AI Commands

Export a small local JSONL file of English JMdict senses that are missing a target language:

```sh
bun run ai:seeds -- --lang ko --limit 20
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

Filter generated candidates into a committed source file:

```sh
bun run ai:filter -- --lang ko --input data/ai-candidates/ko-candidates.jsonl --out sources/ai-glosses/ko.jsonl --append
```

Rejected rows are written under `data/ai-candidates/` by default. After editing or agent review, rebuild SQLite with filtered glosses:

```sh
bun run ai:validate -- --lang ko --input sources/ai-glosses/ko.jsonl
bun run build:db
```

Prepare a small bundle for CLI/agent review of AI-generated glosses:

```sh
bun run ai:review -- --lang ko --limit 500 --offset 100
```

The command prints the exact review prompt and a ready-to-run Claude CLI
command. Review output should be JSONL issues only; an empty output means no
issues were flagged.

If a Batch result has failures, export only those failed seeds for a rerun:

```sh
bun run ai:summary -- --manifest data/ai-batches/<run>/manifest.json
bun run ai:retry-seeds -- --manifest data/ai-batches/<run>/manifest.json --out data/ai-seeds/failed-seeds.jsonl
bun run ai:batch -- submit --input data/ai-seeds/failed-seeds.jsonl
```

Generated files under `data/` are ignored. Filtered and reviewed gloss source files under `sources/` are committed.

## API

See [openapi.yaml](openapi.yaml) for the full OpenAPI description.

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

Full JMdict-simplified import can use the same command with a downloaded full
JSON file. Pass one `--ai-glosses` option per reviewed source file, or use
`bun run build:db` to include the committed reviewed sources.
