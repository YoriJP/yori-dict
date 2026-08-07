# Yori Dict

Open Japanese and English dictionary data with a hosted lookup API.

The Japanese dictionary is built from JMdict-simplified and adds reviewed
generated glosses for languages where open coverage is still incomplete. The
API is designed for build-time consumers: select the Japanese or English
dictionary, send lexical context, and get that dictionary's native entry schema.

Code is licensed under MIT. Dictionary data and SQLite release files are
licensed under CC BY-SA 4.0. See [DATA_SOURCES.md](DATA_SOURCES.md).

Japanese and English are independent data products. They keep separate source inventories,
schemas, versions, release artifacts, and quality gates. The hosted API serves both without
coercing English into the Japanese schema. English is also consumable through its SQLite,
canonical JSONL, and Yomitan v3 artifacts. See [docs/english-dictionary.md](docs/english-dictionary.md).

## Links

- Public API: <https://yori-dict-production.up.railway.app>
- API docs: <https://yori-dict-production.up.railway.app/doc>
- Raw OpenAPI spec: <https://yori-dict-production.up.railway.app/openapi.yaml>
- SQLite data release: <https://github.com/YoriJP/yori-dict/releases/tag/data-2026-08-04.3>

## What Yori Dict Supports

- Japanese lookup by kanji form, kana reading, or basic inflected form.
- English lookup through the independent English release.
- Single lookup and batch lookup API endpoints.
- SQLite data release for direct local use.
- English and German glosses from JMdict.
- Reviewed generated Traditional Chinese, Simplified Chinese, and Korean glosses.
- Requested-language responses: no automatic English fallback.
- Sense annotations from JMdict: usage tags, field of application, dialect, notes,
  cross-references, and loanword origin.
- Human-written Tatoeba examples attached to individual senses.
- Reviewed generated examples staged by authorised enrichment lookups.
- Source-grounded generated Japanese entries staged by authorised enrichment lookups.
- Unofficial JLPT-band estimates joined by JMdict source ID.
- An inflection path explaining how a conjugated lookup reached its dictionary form.

Current coverage and limitations:

- Traditional Chinese coverage is partial but broad for common lookup. The
  `data-2026-08-04.3` release covers 77,863 zh-TW senses, including 19.60% of
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

English batch lookup selects its independent dictionary. Contextual candidates
allow authenticated callers to enrich genuine gaps while ordinary lookup stays
model-free:

```sh
curl -X POST 'https://yori-dict-production.up.railway.app/v1/lookup/batch' \
  -H 'content-type: application/json' \
  --data '{"dictionary":"en","queries":[{"query":"banks","lemma":"bank","context":"Several banks lowered rates."}],"lang":"en"}'
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
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04.3/yori-dict-2026-08-04.3.sqlite.gz
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04.3/yori-dict-2026-08-04.3.sqlite.gz.sha256
shasum -a 256 -c yori-dict-2026-08-04.3.sqlite.gz.sha256
gunzip yori-dict-2026-08-04.3.sqlite.gz
```

Release manifest:

```sh
curl -LO https://github.com/YoriJP/yori-dict/releases/download/data-2026-08-04.3/yori-dict-2026-08-04.3.json
```

The `data-2026-08-04.3` release contains:

| Item | Count |
| --- | ---: |
| Entries | 217,294 |
| Senses | 675,094 |
| Glosses | 1,187,469 |
| Generated glosses (legacy records) | 413,463 |
| Sourced examples | 31,992 |
| Entries with estimated levels | 7,747 |
| Traditional Chinese senses | 77,863 |
| Traditional Chinese glosses | 184,708 |
| Simplified Chinese senses | 77,863 |
| Simplified Chinese glosses | 184,515 |
| Korean senses | 19,072 |
| Korean glosses | 44,240 |

## Local Development

```sh
bun install
bun run data:prepare
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

`download:jmdict` defaults to the JMdict-simplified release that the legacy generated
gloss rows were built against: `3.6.2+20260601171836`. To intentionally
refresh to a different upstream release, pass `--tag` or set
`JMDICT_SIMPLIFIED_TAG`, then revalidate affected legacy rows.
The JLPT source is also pinned by commit in `scripts/download-jmdict.ts`; pass
`--jlpt-commit` only when intentionally refreshing it.

Bounded legacy generated gloss sources remain committed for release compatibility under:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/zh-cn.jsonl
sources/ai-glosses/ko.jsonl
```

Build the independent English dictionary from its committed, checksummed source archives:

```sh
bun run english:build -- --version 2026.08.1
```

This writes English SQLite, canonical JSONL, manifest, and Yomitan v3 artifacts under
`releases/english/`. The English build and release version do not rebuild or change the
Japanese dictionary.

## Data Release

Rebuilding from source remains available independently of service deploys. Prepare a release
SQLite artifact with the existing validation and packaging pipeline:

```sh
bun run download:jmdict
bun run release:check
bun run scripts/package-release.ts --version 2026-08-04.3
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

After publishing the `data-<version>` GitHub release, update `version` and `sha256` in
[`data-release.json`](data-release.json). It is the bootstrap pin for a fresh production database
and remains the public-download verification contract:

```sh
bun run data:download
```

An existing production database is never replaced during application deployment. Import a
validated source release explicitly with `bun run db:import -- --japanese <release.sqlite>` or
`--english <release.sqlite>`. Accepted generated content is preserved.

## Railway

Railway build and deploy settings are defined in [railway.json](railway.json).
Use Railway's GitHub integration to autodeploy this repository.

Attach one volume at `/data` and set `YORI_DB_PATH=/data/yori.sqlite`.

Build command:

```sh
bun install
bun run typecheck
```

Start command:

```sh
bun run start
```

The start command mounts the volume, applies pending Drizzle migrations, and opens the existing
database. Only a missing database is bootstrapped from the pinned Japanese release and committed,
checksummed English sources. Later deployments neither rebuild nor download dictionary data.
Japanese and English releases remain independent outputs of the shared canonical working store.

## API Shape

See [openapi.yaml](openapi.yaml) for the full OpenAPI description.

```txt
GET /health
GET /v1/meta
GET /v1/lookup?q=食べる&lang=zh-tw
GET /v1/lookup?q=bank&dictionary=en
POST /v1/lookup/batch
```

Batch request body:

```json
{
  "dictionary": "ja",
  "queries": ["食べました", "学校"],
  "lang": "zh-tw"
}
```

Lookup returns glosses only for the requested language. It does not fall back to
English when that language has no glosses.

## Authenticated On-Demand Enrichment

Ordinary lookup never calls a model. With a configured `YORI_ENRICHMENT_TOKEN`,
an authorised caller can ask the same endpoint to resolve a missing Japanese or
English entry or complete missing sense examples:

```sh
curl 'http://localhost:3000/v1/lookup?q=取り組んで&lemma=取り組む&reading=とりくむ&context=改革に取り組んでいる。&enrich=true' \
  -H 'authorization: Bearer <token>'
```

The service searches the canonical dictionary and indexed licensed source evidence before
generation. Japanese enrichment uses GPT-5.6 Luna
for eligibility and authoring and Gemini 3 Flash Preview for reject-only review.
English enrichment stays disabled until both `YORI_ENGLISH_AUTHOR_MODEL` and
`YORI_ENGLISH_REVIEW_MODEL` select a configuration that passed the comparative
English evaluation. Calls request Flex first; transient on-demand failures may
fall back to standard once.

Configure `OPENROUTER_API_KEY`, `YORI_ENRICHMENT_TOKEN`, `YORI_DB_PATH`, and comma-separated
`YORI_JA_SOURCE_EVIDENCE_PATHS`. `YORI_ENRICHMENT_CONCURRENCY` is one
global limit shared by both dictionaries. Export accepted generated data with
`bun run enrichment:export`; run the paid regression corpus only with
`bun run enrichment:eval -- --run`.

## Legacy Generated Glosses

Existing Japanese releases still import the committed files under
`sources/ai-glosses/`. Their SQLite rows keep the historical `ai-assisted`
storage value so old releases remain reproducible. Public lookup maps that value
to the current `generated` provenance term.

The old per-sense translation, semantic regeneration, and Claude CLI review
commands have been removed. New gaps go through authenticated source-grounded
canonical entry resolution and one-word reject-only review behind
`OnDemandDictionary.resolve`; callers know nothing about persistence or migrations.

## Help And Contributions

Open an issue for bad glosses, missing important entries, API bugs, or release
artifact problems. For dictionary corrections, include:

- the Japanese word or reading
- the requested language
- the current gloss
- the suggested correction

Keep pull requests small and focused. Data changes should include the command
used to generate or validate them.
