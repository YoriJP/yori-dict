# Yori Dict

Yori Dict is a multilingual Japanese dictionary API built with Bun, Hono, and SQLite.

The project now uses a canonical, product-owned dictionary model:

- source imports are rebuildable
- Yori owns stable IDs such as `yde_00000001`
- source IDs stay in `sourceRefs`
- runtime lookup reads from an immutable canonical SQLite release DB
- reviewed manual and AI corrections are stored as canonical overlay operations

## Quick Start

```bash
bun install
bun run rebuild:canonical --overwrite
export CANONICAL_RELEASE_DB_PATH=data/releases/canonical/yori-dict.sqlite
bun run dev
```

The server runs at `http://localhost:3000`.

Try a lookup:

```bash
curl "http://localhost:3000/v2/lookup?query=食べる&lang=en" | jq
```

## API

Main endpoints:

- `GET /health` returns service health.
- `GET /docs` opens the generated API reference.
- `GET /openapi.yaml` returns the OpenAPI spec.
- `GET /v2/lookup` looks up one word by `query`, `surface`, `lemma`, or `reading`.
- `POST /v2/lookup/batch` looks up up to 100 tokenizer tokens.
- `GET /v2/entries/:id` returns a full canonical entry by product-owned Yori ID.
- `GET /v2/kanji/:literal` returns kanji details.

Tokenizer-style lookup:

```bash
curl "http://localhost:3000/v2/lookup?surface=食べました&lemma=食べる&reading=タベマシタ&lang=en" | jq
```

Batch lookup:

```bash
curl "http://localhost:3000/v2/lookup/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "lang": "en",
    "tokens": [
      { "surface": "食べました", "lemma": "食べる", "reading": "タベマシタ", "pos": "動詞" },
      { "surface": "スシ" }
    ]
  }' | jq
```

## Canonical Data Model

The canonical rebuild path is:

```text
JMdict / KANJIDIC2 / Tatoeba / Wiktionary sources
  -> canonical snapshot
  -> approved manual/AI overlays
  -> canonical SQLite release DB
  -> /v2 API
```

Important rules:

- Yori owns canonical IDs; source IDs are attribution data only.
- `sourceRefs.kind` records where data came from: `jmdict`, `jmnedict`, `kanjidic2`, `wiktionary`, `tatoeba`, `manual`, or `ai`.
- Tatoeba canonical imports enrich existing senses with examples; they do not create entries.
- Wiktionary/Kaikki canonical imports enrich existing senses with glosses; ambiguous multi-sense matches require direct IDs, explicit sense order, a unique POS match, or a single-sense entry.
- Manual and AI data are stored as overlay operations and applied after source imports.
- Only approved overlay operations are applied to release snapshots.
- AI overlays must include `model`, `promptVersion`, and `inputRefs`.

## Repo Map

```text
src/index.ts                  Hono server and canonical /v2 routes
src/domain/                   canonical types, IDs, validation, overlays, quality reports
src/runtime/                  canonical SQLite lookup service
src/sources/                  source parsers and canonical converters
scripts/pipeline/             canonical prepare, import, rebuild, validation, release scripts
tests/                        Bun tests for canonical runtime, sources, and pipeline
sdk/                          generated TypeScript client
```

## Main Commands

| Command | Use |
| --- | --- |
| `bun run dev` | start the local server |
| `bun test` | run tests |
| `bun run typecheck` | run TypeScript type checking |
| `bun run prepare:jmdict` | prepare a JMdict XML source file |
| `bun run prepare:kanjidic2` | prepare a KANJIDIC2 XML source file |
| `bun run import:jmdict:canonical` | import JMdict into a canonical snapshot |
| `bun run import:kanjidic2:canonical` | import KANJIDIC2 into a canonical snapshot |
| `bun run import:tatoeba:canonical` | import Tatoeba examples into an existing canonical snapshot |
| `bun run import:wiktionary:canonical` | import Wiktionary/Kaikki glosses into an existing canonical snapshot |
| `bun run apply:canonical-overlays` | apply approved manual/AI overlay operations to a canonical snapshot |
| `bun run curate:canonical-overlays` | create or review canonical overlay operations |
| `bun run queue:curation` | build a target-language curation queue from a canonical snapshot |
| `bun run suggest:ai-overlays` | convert AI suggestion records into unreviewed overlay operations |
| `bun run preview:canonical-release` | preview overlays in a temporary canonical release DB |
| `bun run rebuild:canonical` | rebuild the canonical snapshot and canonical SQLite DB |
| `bun run release:build:canonical` | build a canonical SQLite release DB from a snapshot |
| `bun run validate:snapshot` | validate canonical snapshot structure |
| `bun run quality:canonical` | report dictionary quality issues in a canonical snapshot |
| `bun run release:manifest:canonical` | write release artifact metadata and hashes |
| `bun run sdk:generate` | regenerate `sdk/` from OpenAPI |

## Manual And AI Overlays

Canonical overlays are JSON files with approved operations:

```json
{
  "schemaVersion": "1.0.0",
  "operations": [
    {
      "id": "manual-replace-yds-00000001-zh-tw",
      "type": "replaceGlosses",
      "sourceKind": "manual",
      "importedAt": "2026-06-04T00:00:00.000Z",
      "reviewStatus": "approved",
      "senseId": "yds_00000001",
      "lang": "zh-tw",
      "glosses": ["吃"]
    }
  ]
}
```

Create manual curation operations:

```bash
bun run curate:canonical-overlays replace-glosses \
  --overlay data/overlays/canonical-overlays.json \
  --sense-id yds_00000001 \
  --lang zh-tw \
  --gloss "吃" \
  --approved

bun run curate:canonical-overlays add-example \
  --overlay data/overlays/canonical-overlays.json \
  --sense-id yds_00000001 \
  --lang zh-tw \
  --japanese "寿司を食べる。" \
  --translation "我吃壽司。"
```

Review overlay operations:

```bash
bun run curate:canonical-overlays list-pending-ai --overlay data/overlays/canonical-overlays.json
bun run curate:canonical-overlays approve --overlay data/overlays/canonical-overlays.json --id manual-yds_00000001-add-example-zh-tw-20260604
bun run curate:canonical-overlays reject --overlay data/overlays/canonical-overlays.json --id ai-yds_00000001-add-gloss-zh-tw-canonical-gloss-v1-20260604
```

Build a quality-driven curation queue:

```bash
bun run queue:curation --lang zh-tw --common-only --limit 100
```

Convert AI suggestion output into unreviewed overlay operations:

```bash
bun run suggest:ai-overlays \
  --queue data/curation/queue.zh-tw.json \
  --suggestions data/curation/suggestions.zh-tw.jsonl \
  --model gemini-3.1-flash-lite \
  --prompt-version canonical-gloss-v1
```

Apply overlays during rebuild:

```bash
bun run rebuild:canonical --overlay-file data/overlays/canonical-overlays.json --overwrite
```

Or apply to an existing snapshot:

```bash
bun run apply:canonical-overlays --overlay data/overlays/canonical-overlays.json
```

Preview overlays before promotion:

```bash
bun run preview:canonical-release --overlay data/overlays/canonical-overlays.json --lookup 食べる --overwrite
```

Write a release manifest after building the release DB:

```bash
bun run release:manifest:canonical \
  --overlay data/overlays/canonical-overlays.json \
  --quality-report data/reports/canonical-quality.json
```

The replacement admin and curation workflow is defined in `CANONICAL_EDITING_WORKFLOW.md`.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | server port, default `3000` |
| `CANONICAL_RELEASE_DB_PATH` | canonical SQLite release DB used by `/v2` |

## Development Notes

- TypeScript strict mode is enabled.
- Generated files live in `sdk/`; do not edit them manually.
- Generated snapshots and release DBs should stay out of git.
- Importer changes should be verified with focused source/pipeline tests.
- Runtime tests build their own temporary canonical release DB.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for setup and data issues.

## License

Code and data are CC-BY-SA-4.0 unless a listed data source has different terms. Source attribution is tracked in the canonical model with `sourceRefs`.
