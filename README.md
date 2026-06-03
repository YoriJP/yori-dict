# Yori Dict

Yori Dict is a multilingual Japanese dictionary API built with Bun, Hono, and SQLite.

It serves fast lookup results for Japanese words across English, German, Korean, Simplified Chinese, and Traditional Chinese. The core idea is simple: keep the dictionary data rebuildable, serve from an immutable release database, and layer reviewed updates on top without mutating the live release.

## Why This Project Exists

This is a side project for learning and interview discussion. It demonstrates:

- API design with typed responses and an OpenAPI spec
- SQLite-backed read performance
- deterministic data import and release workflows
- safe handling of generated translation candidates through review
- a small internal admin surface for release and data operations

## Quick Start

```bash
bun install
bun run data:pull
bun run build:db
bun run dev
```

The server runs at `http://localhost:3000`.

Try a lookup:

```bash
curl "http://localhost:3000/v1/lookup?word=食べる&lang=en" | jq
```

## API

### `GET /v1/lookup`

Looks up a Japanese word by written form or reading.

Query parameters:

| Name | Required | Notes |
| --- | --- | --- |
| `word` | yes | Kanji, hiragana, or katakana |
| `lang` | no | `en`, `de`, `ko`, `zh-cn`, `zh-tw`; defaults to `en` |

Example response:

```json
{
  "word": "食べる",
  "reading": "たべる",
  "romaji": "taberu",
  "partOfSpeech": ["ichidan verb", "transitive verb"],
  "definitions": ["to eat"],
  "frequency": 195,
  "conjugations": {
    "dictionary": "食べる",
    "polite": "たべます",
    "negative": "たべない",
    "past": "たべた",
    "te": "たべて"
  },
  "examples": []
}
```

Other endpoints:

- `GET /health` returns service health
- `GET /docs` opens the generated API reference
- `GET /openapi.yaml` returns the OpenAPI spec
- `/admin/*` is an internal operations UI protected by `ADMIN_TOKEN`

### Canonical `/v2` API

The canonical dictionary API is the new product-owned model. It is built from a canonical snapshot and served from a separate SQLite release DB. It does not replace `/v1` yet.

Use it with tokenizer output:

```bash
curl "http://localhost:3000/v2/lookup?surface=食べました&lemma=食べる&reading=タベマシタ&lang=en" | jq
```

Main endpoints:

- `GET /v2/lookup` looks up one word by `query`, `surface`, `lemma`, or `reading`.
- `POST /v2/lookup/batch` looks up up to 100 tokenizer tokens.
- `GET /v2/entries/:id` returns a full canonical entry by product-owned Yori ID.
- `GET /v2/kanji/:literal` returns kanji details from canonical kanji data.

## Mental Model

The repo has three data layers:

```text
source imports -> data/core.json + data/lang/*.json -> immutable release DB
                                                        +
                                                 updates.sqlite overlay
                                                        =
                                                 lookup response
```

Important rules:

- `data/core.json` stores language-independent word data.
- `data/lang/*.json` stores definitions and examples per language.
- `release:build` creates a versioned SQLite release under `releases/`.
- `release:activate` switches the active release.
- `updates.sqlite` stores incremental source and AI updates.
- source updates are effective immediately.
- AI updates only affect lookup after approval.
- `release:promote` bakes the current effective data into a new release.

The canonical model adds a cleaner rebuild path for the next API:

```text
JMdict / KANJIDIC2 / Tatoeba / Wiktionary sources -> canonical snapshot -> canonical SQLite release DB -> /v2 API
```

Canonical rules:

- Yori owns canonical IDs such as `yde_00000001`; source IDs stay in `sourceRefs`.
- `sourceRefs.kind` records where data came from, including `jmdict`, `jmnedict`, `kanjidic2`, `wiktionary`, `tatoeba`, `manual`, and `ai`.
- Tatoeba canonical imports enrich existing entries with examples; they do not create new dictionary entries.
- Wiktionary canonical imports enrich existing senses with glosses; ambiguous multi-sense entries require direct IDs or a POS match.
- downloaded source files, generated snapshots, and generated canonical release DBs are ignored by git.
- source parsers and importers should be covered by focused tests before real data rebuilds.

## Repo Map

```text
src/index.ts             Hono server and public routes
src/db.ts                runtime lookup against release DB + overlay updates
src/types.ts             public API types and language normalization
src/conjugator.ts        Japanese conjugation logic
src/storage.ts           release/update schema and file helpers
src/update-store.ts      updates.sqlite read/write helpers
src/release-service.ts   build, activate, promote, and list releases
src/admin/               internal admin routes, service layer, and HTML views
scripts/import/          source importers
scripts/release/         release CLI scripts
scripts/update/          overlay update CLI scripts
tests/                   Bun tests
sdk/                     generated TypeScript client
```

## Main Commands

| Command | Use |
| --- | --- |
| `bun run dev` | start the local server |
| `bun test` | run tests |
| `bun run data:pull` | materialize Git LFS data files |
| `bun run build:db` | build and activate a release from checked-in JSON |
| `bun run rebuild:all` | run deterministic imports and build a candidate release |
| `bun run release:build` | build a release without using the dev wrapper |
| `bun run rebuild:canonical` | rebuild the canonical snapshot and canonical SQLite DB |
| `bun run import:tatoeba:canonical` | import Tatoeba examples into an existing canonical snapshot |
| `bun run import:wiktionary:canonical` | import Wiktionary/Kaikki glosses into an existing canonical snapshot |
| `bun run validate:snapshot` | validate canonical snapshot structure |
| `bun run quality:canonical` | report dictionary quality issues in a canonical snapshot |
| `bun run release:activate --version <version>` | switch to an existing release |
| `bun run release:promote` | bake effective overlay updates into a new release |
| `bun run verify:rebuild` | compare a clean rebuild against the current snapshot |
| `bun run update:source` | write deterministic source changes into `updates.sqlite` |
| `bun run import:gemini` | generate review-only AI update candidates |
| `bun run sdk:generate` | regenerate `sdk/` from OpenAPI |

## Admin UI

Set a token and start the server:

```bash
export ADMIN_TOKEN="change-me"
bun run dev
```

Open `http://localhost:3000/admin`.

Use any username and the token as the Basic Auth password. The admin UI is intentionally internal. Anyone with `ADMIN_TOKEN` can review updates, create words, build releases, activate releases, promote releases, and run jobs.

Admin workflow summary:

- inspect one entry across release, source update, AI update, and effective lookup layers
- review pending AI translation/example candidates
- create a new word in snapshot JSON
- build or activate immutable releases
- promote approved effective updates into a release
- inspect update batches and failures

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | server port, default `3000` |
| `ADMIN_TOKEN` | enables and protects `/admin` |
| `RELEASE_DB_PATH` | pin runtime to a specific release DB |
| `RELEASE_VERSION` | optional label for an env-pinned release |
| `RELEASE_MANIFEST_PATH` | optional manifest path for an env-pinned release |
| `UPDATES_DATABASE_PATH` | overlay DB path, default `./updates.sqlite` |
| `DATABASE_PATH` | legacy DB fallback, default `./dict.sqlite` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | optional Gemini import key |

## Development Notes

- TypeScript strict mode is enabled.
- Generated files live in `sdk/`; do not edit them manually.
- Large dictionary snapshots may require Git LFS.
- Importer changes should be verified with focused tests and, when relevant, `bun run verify:rebuild`.
- Runtime lookup tests may need an active release DB. If tests fail with `No active release database found`, run `bun run build:db` or set `RELEASE_DB_PATH`.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for setup and data issues.

## License

Code and data are CC-BY-SA-4.0 unless a listed data source has different terms. Source attribution is tracked in the import pipeline and OpenAPI/documentation tables.
