# Troubleshooting

This file covers setup issues for the canonical dictionary runtime.

## Start Here

For a normal local run:

```bash
bun install
bun run rebuild:canonical --overwrite
export CANONICAL_RELEASE_DB_PATH=data/releases/canonical/yori-dict.sqlite
bun run dev
```

If a command fails, check the matching section below.

## Canonical Dictionary Is Not Configured

Response:

```json
{ "error": "Canonical dictionary is not configured" }
```

Fix:

```bash
bun run rebuild:canonical --overwrite
export CANONICAL_RELEASE_DB_PATH=data/releases/canonical/yori-dict.sqlite
```

`CANONICAL_RELEASE_DB_PATH` must point at a canonical SQLite release DB built by:

```bash
bun run release:build:canonical
```

or:

```bash
bun run rebuild:canonical
```

## Missing Source Files

`rebuild:canonical` expects local source files unless you pass explicit paths.

Common options:

```bash
bun run rebuild:canonical \
  --jmdict-file data/sources/JMdict_e.xml \
  --kanjidic2-file data/sources/kanjidic2.xml \
  --overwrite
```

If you already prepared the source files:

```bash
bun run rebuild:canonical --skip-prepare --overwrite
```

## Invalid Snapshot

Validate the canonical snapshot directly:

```bash
bun run validate:snapshot --snapshot data/snapshots/yori-dict.snapshot.json
```

Common causes:

- duplicate product-owned IDs
- aliases pointing to unknown entries/forms/readings
- AI source refs missing `model`, `promptVersion`, or `inputRefs`
- examples or glosses attached to the wrong sense

## Overlay Validation Fails

Validate and apply overlays with:

```bash
bun run apply:canonical-overlays --overlay data/overlays/canonical-overlays.json
```

Rules:

- the overlay file must have `schemaVersion: "1.0.0"`
- operations must have unique `id` values
- only `reviewStatus: "approved"` operations are applied
- AI operations must include `model`, `promptVersion`, and `inputRefs`

## Word Not Found

First confirm the canonical DB is being used:

```bash
echo "$CANONICAL_RELEASE_DB_PATH"
ls -lh "$CANONICAL_RELEASE_DB_PATH"
```

Then inspect aliases:

```bash
sqlite3 "$CANONICAL_RELEASE_DB_PATH" \
  "SELECT surface, reading, entry_public_id, alias_type, score FROM lookup_aliases WHERE surface = '食べる' OR normalized_surface = '食べる';"
```

If aliases exist but lookup still fails, check whether the requested language has glosses:

```bash
sqlite3 "$CANONICAL_RELEASE_DB_PATH" \
  "SELECT g.lang, g.text FROM glosses g JOIN senses s ON s.public_id = g.sense_public_id WHERE s.entry_public_id = 'yde_00000001';"
```

## Missing Translations

Run the quality report:

```bash
bun run quality:canonical --snapshot data/snapshots/yori-dict.snapshot.json
```

If the source has data but the release DB does not, rebuild:

```bash
bun run rebuild:canonical --overwrite
```

If the missing content is manual or AI-reviewed, make sure the rebuild includes the overlay file:

```bash
bun run rebuild:canonical --overlay-file data/overlays/canonical-overlays.json --overwrite
```

## Docker Build

The Docker image expects a canonical release DB to be present in the build context under:

```text
data/releases/canonical/yori-dict.sqlite
```

Build it first:

```bash
bun run rebuild:canonical --overwrite
bun run docker:build
```

## Slow Lookup

Check the release DB and indexes:

```bash
ls -lh "$CANONICAL_RELEASE_DB_PATH"
sqlite3 "$CANONICAL_RELEASE_DB_PATH" ".indexes"
```

Profile a query:

```bash
sqlite3 "$CANONICAL_RELEASE_DB_PATH" \
  "EXPLAIN QUERY PLAN SELECT * FROM lookup_aliases WHERE normalized_surface = '食べる' LIMIT 20;"
```
