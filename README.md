# Yori Dict

Open Japanese dictionary API and SQLite database with multilingual lookup support.

Yori Dict is built from JMdict-simplified and adds reviewed AI-assisted glosses
for languages where open Japanese dictionary coverage is still incomplete. The
API is designed for frontend lookup: send a Japanese word, reading, or inflected
form and get a compact dictionary response.

Code is licensed under MIT. Dictionary data and SQLite release files are
licensed under CC BY-SA 4.0. See [DATA_SOURCES.md](DATA_SOURCES.md).

## Links

- Public API: <https://yori-dict-production.up.railway.app>
- API docs: <https://yori-dict-production.up.railway.app/doc>
- Raw OpenAPI spec: <https://yori-dict-production.up.railway.app/openapi.yaml>
- SQLite data release: <https://github.com/anilahsu/yori-dict/releases/tag/data-2026-06-10>

## What Yori Dict Supports

- Japanese lookup by kanji form, kana reading, or basic inflected form.
- Single lookup and batch lookup API endpoints.
- SQLite data release for direct local use.
- English and German glosses from JMdict.
- Reviewed AI-assisted Traditional Chinese and Korean glosses.
- Requested-language responses: no automatic English fallback.

Current coverage and limitations:

- Traditional Chinese coverage is partial but broad for common lookup. The
  `data-2026-06-10` release covers 77,863 zh-TW senses, including 19.60% of
  common JMdict senses.
- Korean coverage is earlier. The same release covers 4,595 Korean senses,
  including 2.45% of common JMdict senses.
- Lookup responses omit senses that have no glosses in the requested language.
  For example, if an entry has four JMdict senses but only two Korean senses
  have Korean glosses, `lang=ko` returns those two senses instead of returning
  empty gloss lists for the other two.
- Deinflection is word-level lookup help, not full sentence parsing.

## Quick API Use

```sh
curl 'https://yori-dict-production.up.railway.app/'
curl 'https://yori-dict-production.up.railway.app/health'
curl 'https://yori-dict-production.up.railway.app/v1/meta'
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&lang=zh-tw'
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=教室&lang=ko'
```

Batch lookup:

```sh
curl -X POST 'https://yori-dict-production.up.railway.app/v1/lookup/batch' \
  -H 'content-type: application/json' \
  --data '{"queries":["食べました","学校","教室"],"lang":"ko"}'
```

Supported `lang` values:

```txt
en, de, zh-tw, zh-cn, ko
```

`lang` defaults to `en`.

## SQLite Download

Download and verify the current SQLite database:

```sh
curl -LO https://github.com/anilahsu/yori-dict/releases/download/data-2026-06-10/yori-dict-2026-06-10.sqlite.gz
curl -LO https://github.com/anilahsu/yori-dict/releases/download/data-2026-06-10/yori-dict-2026-06-10.sqlite.gz.sha256
shasum -a 256 -c yori-dict-2026-06-10.sqlite.gz.sha256
gunzip yori-dict-2026-06-10.sqlite.gz
```

Release manifest:

```sh
curl -LO https://github.com/anilahsu/yori-dict/releases/download/data-2026-06-10/yori-dict-2026-06-10.json
```

The `data-2026-06-10` release contains:

| Item | Count |
| --- | ---: |
| Entries | 217,294 |
| Senses | 675,094 |
| Glosses | 969,503 |
| AI-assisted glosses | 195,497 |
| Traditional Chinese senses | 77,863 |
| Traditional Chinese glosses | 184,738 |
| Korean senses | 4,595 |
| Korean glosses | 10,759 |

## Local Development

```sh
bun install
bun run download:jmdict
bun run build:db
bun run dev
```

Then test the local API:

```sh
curl 'http://localhost:3000/v1/lookup?q=食べました&lang=zh-tw'
```

Useful checks:

```sh
bun run lookup:check
bun run typecheck
bun test
```

## Data Build

The repo keeps a small fixture in git for tests. Full JMdict-simplified data is
downloaded into ignored local files:

```sh
bun run download:jmdict
bun run build:db
```

This creates:

```txt
data/raw/jmdict-all.json
data/yori.sqlite
```

Both are local generated files and are not committed.

`download:jmdict` defaults to the JMdict-simplified release that the reviewed AI
gloss sources were built against: `3.6.2+20260601171836`. To intentionally
refresh to a different upstream release, pass `--tag` or set
`JMDICT_SIMPLIFIED_TAG`, then revalidate and review affected AI gloss rows.

Reviewed AI gloss sources are committed under:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/ko.jsonl
```

## Release

Prepare a release SQLite artifact:

```sh
bun run download:jmdict
bun run release:check
bun run scripts/package-release.ts --version 2026-06-10
```

This writes ignored release files under `releases/`:

```txt
releases/yori-dict-<artifactVersion>.sqlite
releases/yori-dict-<artifactVersion>.sqlite.gz
releases/yori-dict-<artifactVersion>.sqlite.gz.sha256
releases/yori-dict-<artifactVersion>.json
```

Upload the `.sqlite.gz`, `.sha256`, and `.json` files as GitHub release assets.
Users can decompress the SQLite file and use it directly.

## Railway

Railway build and deploy settings are defined in [railway.json](railway.json).
Use Railway's GitHub integration to autodeploy this repository.

Build command:

```sh
bun install
bun run download:jmdict
bun run build:db
```

Start command:

```sh
bun run start
```

The server reads `YORI_DB_PATH`, defaulting to `data/yori.sqlite`.

## API Shape

See [openapi.yaml](openapi.yaml) for the full OpenAPI description.

```txt
GET /health
GET /v1/meta
GET /v1/lookup?q=食べる&lang=zh-tw
POST /v1/lookup/batch
```

Batch request body:

```json
{
  "queries": ["食べました", "学校"],
  "lang": "zh-tw"
}
```

Lookup returns glosses only for the requested language. It does not fall back to
English when that language has no glosses.

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

When imported into SQLite, they are marked as `ai-assisted` and `checked`. This
means the row passed deterministic validation and CLI/agent review. It does not
mean it is perfect or native-speaker certified. If you find a bad gloss, please
open an issue with the word, language, and expected correction.

## Maintainer AI Commands

Export English JMdict senses that are missing a target language:

```sh
bun run ai:seeds -- --lang ko --limit 20
```

Generate local AI candidates from those seeds:

```sh
GEMINI_API_KEY=... bun run ai:generate -- --limit 20
```

Use the Batch API for larger offline runs:

```sh
bun run ai:batch -- submit --input data/ai-seeds/ko-seeds.jsonl --out data/ai-candidates/ko-candidates.jsonl
```

The submit command writes a manifest under `data/ai-batches/`. When the batch
finishes, collect the results with the manifest path printed by submit:

```sh
bun run ai:batch -- collect --manifest data/ai-batches/<run>/manifest.json
```

Filter generated candidates into a committed source file:

```sh
bun run ai:filter -- --lang ko --input data/ai-candidates/ko-candidates.jsonl --out sources/ai-glosses/ko.jsonl --append
```

Validate and rebuild SQLite:

```sh
bun run ai:validate -- --lang ko --input sources/ai-glosses/ko.jsonl
bun run build:db
```

Prepare a review bundle:

```sh
bun run ai:review -- --lang ko --limit 500 --offset 100
```

The command prints the exact review prompt and a ready-to-run Claude CLI
command. Review output should be JSONL issues only; an empty output means no
issues were flagged.

If a batch result has failures, export only those failed seeds for a rerun:

```sh
bun run ai:summary -- --manifest data/ai-batches/<run>/manifest.json
bun run ai:retry-seeds -- --manifest data/ai-batches/<run>/manifest.json --out data/ai-seeds/failed-seeds.jsonl
bun run ai:batch -- submit --input data/ai-seeds/failed-seeds.jsonl
```

Generated files under `data/` are ignored. Filtered and reviewed gloss source
files under `sources/` are committed.

## Help And Contributions

Open an issue for bad glosses, missing important entries, API bugs, or release
artifact problems. For dictionary corrections, include:

- the Japanese word or reading
- the requested language
- the current gloss
- the suggested correction

Keep pull requests small and focused. Data changes should include the command
used to generate or validate them.
