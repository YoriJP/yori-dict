# Troubleshooting

This file covers the setup issues that actually block local development.

## Start Here

For a normal local run:

```bash
bun install
bun run data:pull
bun run build:db
bun run dev
```

If a command fails, check the matching section below.

## No Active Release Database

Error:

```text
No active release database found. Run "bun run build:db" or set RELEASE_DB_PATH.
```

Fix:

```bash
bun run build:db
```

For tests that intentionally use a fixture DB, set:

```bash
export RELEASE_DB_PATH=/path/to/release.sqlite
export RELEASE_VERSION=test
```

## Git LFS Pointer Instead Of JSON

Error:

```text
SyntaxError: Failed to parse JSON
```

Or the file starts with:

```text
version https://git-lfs.github.com/spec/v1
```

Fix:

```bash
git lfs install
bun run data:pull
bun run build:db
```

## Missing Data Files

If `build:db` cannot find `data/core.json` or `data/lang/*.json`, either pull the checked-in snapshots:

```bash
bun run data:pull
```

Or rebuild from sources:

```bash
bun run rebuild:all
bun run release:activate --version <version>
```

## Import Download Problems

If an importer fails after a partial or corrupt download:

```bash
rm -rf data/cache
bun run import:jmdict --lang en --mode diff
```

Use `--mode diff` first when you only want to verify the importer can run.

## Import Modes

Common importer modes:

| Mode | Behavior |
| --- | --- |
| `diff` | preview changes without writing files |
| `merge` | add missing data and merge with existing entries |
| `refresh` | remove and re-import data from that source |
| `replace` | treat incoming data as the full source snapshot |

Not every importer supports every mode. Check the script help when unsure:

```bash
bun run import:jmdict --help
```

## Database Locked

Usually another server or SQLite process is using the DB.

```bash
lsof -i :3000
```

Stop the extra process, then retry. Avoid deleting release files while the server is running.

## Word Not Found

First confirm which DB is active:

```bash
cat releases/current.json | jq
```

Then query the active release:

```bash
ACTIVE_DB="$(jq -r '.dbPath' releases/current.json)"
sqlite3 "$ACTIVE_DB" "SELECT id, word, reading FROM words WHERE word = '食べる' OR reading = 'たべる';"
```

If the word exists in snapshot JSON but not lookup, build and activate a release:

```bash
bun run build:db
```

If an AI update exists but lookup does not show it, inspect `/admin/entry`. Pending and rejected AI updates are ignored, and source updates can outrank AI updates.

## Missing Translations

Check release counts:

```bash
ACTIVE_DB="$(jq -r '.dbPath' releases/current.json)"
sqlite3 "$ACTIVE_DB" "SELECT lang, COUNT(*) FROM translations GROUP BY lang;"
```

If a language is missing, run the relevant importer or rebuild:

```bash
bun run rebuild:all
```

## Admin Login Fails

Set `ADMIN_TOKEN` before starting the server:

```bash
export ADMIN_TOKEN="change-me"
bun run dev
```

Basic Auth uses any username and `ADMIN_TOKEN` as the password.

## Docker Build Fails On Data

Docker needs real LFS files on the host before building:

```bash
bun run data:pull
bun run docker:build
```

## Slow Lookup

Check the active DB and indexes:

```bash
ACTIVE_DB="$(jq -r '.dbPath' releases/current.json)"
ls -lh "$ACTIVE_DB"
sqlite3 "$ACTIVE_DB" ".indexes"
```

Profile one query:

```bash
sqlite3 "$ACTIVE_DB" "EXPLAIN QUERY PLAN SELECT * FROM words WHERE word = '食べる' LIMIT 1;"
```

## Conjugations Missing

Conjugations depend on part-of-speech tags.

```bash
curl "http://localhost:3000/v1/lookup?word=食べる" | jq '.partOfSpeech'
```

Expected tags include `ichidan verb`, `godan verb`, `suru verb`, `kuru verb`, or `i-adjective`.

If the tag is wrong, fix the source data or add a reviewed manual entry, then build or promote as appropriate.
