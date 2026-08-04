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
- SQLite data release: <https://github.com/YoriJP/yori-dict/releases/tag/data-2026-08-04>

## What Yori Dict Supports

- Japanese lookup by kanji form, kana reading, or basic inflected form.
- Single lookup and batch lookup API endpoints.
- SQLite data release for direct local use.
- English and German glosses from JMdict.
- Reviewed AI-assisted Traditional Chinese, Simplified Chinese, and Korean glosses.
- Requested-language responses: no automatic English fallback.
- Sense annotations from JMdict: usage tags, field of application, dialect, notes,
  cross-references, and loanword origin.
- Human-written Tatoeba examples attached to individual senses.
- Reviewed generated examples staged by authorised enrichment lookups.
- Unofficial JLPT-band estimates joined by JMdict source ID.
- An inflection path explaining how a conjugated lookup reached its dictionary form.

Current coverage and limitations:

- Traditional Chinese coverage is partial but broad for common lookup. The
  `data-2026-08-04` release covers 77,863 zh-TW senses, including 19.60% of
  common JMdict senses.
- Simplified Chinese is derived from the reviewed Traditional Chinese source
  with OpenCC phrase conversion. The same release covers 77,863 zh-CN
  senses, including 19.60% of common JMdict senses.
- Korean coverage is expanding. The same release covers 19,072 Korean senses,
  including 10.18% of common JMdict senses.
- Lookup responses omit senses that have no glosses in the requested language.
  For example, if an entry has four JMdict senses but only two Korean senses
  have Korean glosses, `lang=ko` returns those two senses instead of returning
  empty gloss lists for the other two.
- Deinflection is word-level lookup help, not full sentence parsing.
- `estimatedLevel` is omitted when the source lists do not cover an entry; it is
  an estimate, not an official JLPT classification.

## Quick API Use

```sh
curl 'https://yori-dict-production.up.railway.app/'
curl 'https://yori-dict-production.up.railway.app/health'
curl 'https://yori-dict-production.up.railway.app/v1/meta'
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&lang=zh-tw'
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&lang=zh-cn'
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

## Sense Annotations

Each sense carries the annotations JMdict provides. These fields are omitted when
JMdict has no values for them, so most senses stay small:

| Field | Meaning | Senses with values |
| --- | --- | ---: |
| `misc` | Usage tags, such as `uk` (usually written in kana) or `col` | 6.8% |
| `field` | Field of application, such as `comp`, `med`, `finc` | 5.0% |
| `related` | Cross-references to related entries | 5.1% |
| `info` | Free-text notes about the sense | 1.0% |
| `languageSource` | Loanword origin, including a `wasei` flag for wasei-eigo | 0.9% |
| `antonym` | Cross-references to antonyms | 0.2% |
| `dialect` | Dialect tags, such as `ksb` (Kansai-ben) | 0.1% |

Glosses may also carry `type` (`literal`, `figurative`, `explanation`, or
`trademark`).

Tag codes in `misc`, `field`, `dialect`, and `partOfSpeech` are short JMdict
identifiers. `/v1/meta` returns a `tags` object mapping every code to a
description, so clients can render them without a hardcoded table:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/meta' | jq '.tags.uk'
# "word usually written using kana alone"
```

Cross-references in `related` and `antonym` are arrays in one of the
JMdict-simplified forms: `[word]`, `[word, senseIndex]`, `[word, reading]`, or
`[word, reading, senseIndex]`.

## Examples, Estimated Levels, and Inflection Paths

Each entry carries `headwordLanguage` (`ja` for the current dictionary).
`estimatedLevel` is present only when the pinned unofficial vocabulary lists
cover the entry. If a source ID occurs in several bands, the easiest band wins.

Examples are ordered within their JMdict sense. `source` distinguishes
`sourced` examples from checked `generated` examples; sourced examples also
carry `sourceName` and `sourceId`. `text` is the Japanese sentence,
`translations` keeps each translation's `lang` and `text` explicit, and
`reviewStatus` distinguishes untouched source material from checked additions.

A lookup of a conjugated form adds `inflectionPath`, an ordered list of the
actual reduction steps used for the selected result. Each step carries `from`,
`to`, and a learner-readable `reason`. Exact lookups omit it, and adding it does
not change result ranking.

## SQLite Download

Download and verify the current SQLite database:

```sh
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04/yori-dict-2026-08-04.sqlite.gz
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04/yori-dict-2026-08-04.sqlite.gz.sha256
shasum -a 256 -c yori-dict-2026-08-04.sqlite.gz.sha256
gunzip yori-dict-2026-08-04.sqlite.gz
```

Release manifest:

```sh
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04/yori-dict-2026-08-04.json
```

The `data-2026-08-04` release contains:

| Item | Count |
| --- | ---: |
| Entries | 217,294 |
| Senses | 675,094 |
| Glosses | 1,187,461 |
| AI-assisted glosses | 413,455 |
| Sourced examples | 31,992 |
| Entries with estimated levels | 7,747 |
| Traditional Chinese senses | 77,863 |
| Traditional Chinese glosses | 184,700 |
| Simplified Chinese senses | 77,863 |
| Simplified Chinese glosses | 184,515 |
| Korean senses | 19,072 |
| Korean glosses | 44,240 |

## Local Development

```sh
bun install
bun run data:download
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
data/raw/jmdict-examples-eng.json
data/raw/jlpt-vocab/n1.csv ... n5.csv
data/yori.sqlite
```

Both are local generated files and are not committed.

`download:jmdict` defaults to the JMdict-simplified release that the reviewed AI
gloss sources were built against: `3.6.2+20260601171836`. To intentionally
refresh to a different upstream release, pass `--tag` or set
`JMDICT_SIMPLIFIED_TAG`, then revalidate and review affected AI gloss rows.
The JLPT source is also pinned by commit in `scripts/download-jmdict.ts`; pass
`--jlpt-commit` only when intentionally refreshing it.

Reviewed AI gloss sources are committed under:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/zh-cn.jsonl
sources/ai-glosses/ko.jsonl
```

## Data Release

Rebuilding from source remains available independently of service deploys. Prepare a release
SQLite artifact with the existing validation and packaging pipeline:

```sh
bun run download:jmdict
bun run release:check
bun run scripts/package-release.ts --version 2026-08-04
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

After publishing the `data-<version>` GitHub release, pin the service to it by updating only
`version` and `sha256` in [`data-release.json`](data-release.json). Copy the SHA-256 from the
published `.sqlite.gz.sha256` file, then verify the complete public download path locally:

```sh
bun run data:download
```

Commit the `data-release.json` diff normally. This changes the deployed data without requiring
an application-code change. The deploy downloads the same `.sqlite.gz` asset offered to public
users, verifies it against the committed checksum before installing it, and only then replaces the
current database. A mismatch stops the build and leaves any existing database untouched.

## Railway

Railway build and deploy settings are defined in [railway.json](railway.json).
Use Railway's GitHub integration to autodeploy this repository.

Build command:

```sh
bun install
bun run data:download
```

Start command:

```sh
bun run start
```

The server reads `YORI_DB_PATH`, defaulting to `data/yori.sqlite`. Railway obtains that database
from the release pinned in `data-release.json`; deploys do not contact JMdict upstream.

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

Simplified Chinese is different: it is generated from the reviewed
Traditional Chinese source with OpenCC phrase conversion:

```sh
bun run zh-cn:convert
```

The generated `sources/ai-glosses/zh-cn.jsonl` file is validated and committed
as its own source file.

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

`ai:review` writes a bounded JSONL review bundle. Each row contains the AI
glosses plus the original JMdict context:

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

Run the same bounded bundle through Claude:

```sh
bun run ai:review:run -- --lang ko --limit 500 --offset 100
```

The runner sends the prepared rows through stdin, keeps repository tools
disabled, defaults to low effort, one turn, and a USD 1.00 budget, and writes
validated JSONL issues plus raw output and diagnostic logs under
`data/ai-review/<lang>/offset-<offset>/`. Filtered runs add a `common-only/` or
`non-common-only/` scope directory before the offset. When using a custom
`--source` or `--db`, pass explicit `--out` and `--issues` paths if its artifacts
must coexist with the default input. Override the execution limits when needed:

```sh
bun run ai:review:run -- --lang ko --limit 500 --offset 100 --model sonnet --effort low --max-turns 1 --max-budget-usd 1.00
```

Each bundle is capped at 500 rows. Bundle-only mode prints the next offset after
preparing the bundle; run mode prints it only after Claude output is validated.
Review output contains JSONL issues only; an empty output means no issues were
flagged. The runner rejects malformed output and issue rows whose `senseId` was
not present in the prepared bundle.
Each offset keeps its own bundle, issues, raw output, and diagnostic logs. Run
mode clears that checkpoint's validated issues before preparing a new bundle,
and bundle-only regeneration clears existing issues after replacing the bundle,
so stale results cannot look current.

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
