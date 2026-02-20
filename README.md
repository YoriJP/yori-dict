# Yori Dict 🈳

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-CC--BY--SA--4.0-green.svg?style=for-the-badge)](LICENSE)

**Fast, multilingual Japanese dictionary API with automatic verb conjugations.**

- ⚡ **~1ms response time** - SQLite with optimized indexes
- 🌍 **Multilingual** - English, German, Korean, Chinese (Simplified & Traditional)
- 🔤 **Auto conjugations** - ichidan, godan, suru, kuru verbs + i-adjectives
- 📝 **Example sentences** - 138k+ curated examples from Tatoeba
- 🎯 **JLPT levels** - N5-N1 tagged for study progress

---

## Quick Try

```bash
# One-liner to start
curl -s "https://yori-dict-production.up.railway.app/v1/lookup?word=食べる&lang=en" | jq
```

**Response:**
```json
{
  "word": "食べる",
  "reading": "たべる",
  "romaji": "taberu",
  "partOfSpeech": ["ichidan verb", "transitive verb"],
  "definitions": ["to eat", "to live on (e.g. a salary)"],
  "conjugations": {
    "dictionary": "食べる",
    "polite": "たべます",
    "negative": "たべない",
    "past": "たべた",
    "te": "たべて"
  },
  "examples": [
    {"japanese": "毎朝食べます", "translation": "I eat every morning"}
  ]
}
```

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+ (`curl -fsSL https://bun.sh/install | bash`)
- ~500MB disk space
- Git LFS (`git lfs install`)

### Install & Run

```bash
# Clone and install
git clone https://github.com/user/yori-dict.git
cd yori-dict
bun install

# Option A: Use existing data (fastest)
bun run data:pull    # Download from Git LFS
bun run build:db     # Build SQLite (~10s)
bun run dev          # Start server

# Option B: Build from scratch (fresh data)
bun run rebuild:all  # base imports + enrichment + build:db
bun run dev
```

Server runs at `http://localhost:3000`

---

## API Reference

### `GET /docs`

Interactive API reference UI (Scalar). Open in a browser:

```
http://localhost:3000/docs
```

The spec is also available as a raw file at `GET /openapi.yaml` and in the repo at [`openapi.yaml`](openapi.yaml).

---

### `GET /v1/lookup`

Lookup a Japanese word by kanji or reading.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `word` | string | ✅ | Japanese word (kanji, hiragana, or katakana) |
| `lang` | string | ❌ | Target language: `en`, `de`, `ko`, `zh-cn`, `zh-tw` (aliases `zh-CN`, `zh-TW` also accepted; default: `en`) |

**Examples:**

```bash
# Basic lookup
curl "localhost:3000/v1/lookup?word=日本語"

# With language
curl "localhost:3000/v1/lookup?word=食べる&lang=de"

# Reading works too
curl "localhost:3000/v1/lookup?word=たべる"
```

**Response Schema:**
```json
{
  "word": "string",           // Kanji form
  "reading": "string",        // Hiragana reading
  "romaji": "string",         // Romanized reading
  "partOfSpeech": ["string"], // Array of POS tags
  "definitions": ["string"],  // Array of meanings
  "conjugations": {           // Optional - only for verbs/adjectives
    "dictionary": "string",
    "polite": "string",
    "negative": "string",
    "past": "string",
    "te": "string"
  },
  "examples": [               // Optional - may be empty
    {"japanese": "string", "translation": "string"}
  ]
}
```

**Errors:**

| Status | Response | When |
|--------|----------|------|
| 400 | `{"error": "Missing required parameter: word"}` | No word provided |
| 400 | `{"error": "Invalid language..."}` | Unsupported language code |
| 404 | `{"error": "Word not found"}` | Word not in dictionary |

### `GET /health`

Returns `{"status": "ok"}` when the server is running.

---

## Data Sources & Coverage

| Language | Entries | Examples | Sources |
|----------|---------|----------|---------|
| **English** | ~214k | ~64k | JMdict, Wiktionary (+55k defs), Tatoeba |
| **German** | ~128k | ~45k | JMdict, Wadoku (+2.5k defs), Tatoeba |
| **Chinese (CN)** | ~26k | ~14k | Kaikki, Tatoeba (`jpn-cmn`) |
| **Chinese (TW)** | ~26k | ~14k | Kaikki, Tatoeba (`jpn-cmn`) |
| **Korean** | ~5k | ~1.7k | Kaikki, Tatoeba (`jpn-kor`) |

**Source Details:**

| Source | Data | License | Imported Via |
|--------|------|---------|--------------|
| [JMdict-simplified](https://github.com/scriptin/jmdict-simplified) | Base dictionary | CC-BY-SA-4.0 | `import:jmdict` |
| [Tatoeba](https://tatoeba.org) via [ManyThings](https://manythings.org/anki/) and [raw exports](https://downloads.tatoeba.org/exports/per_language/) | Example sentences | CC-BY-2.0 | `import:tatoeba` |
| [Wiktionary](https://kaikki.org) | Additional definitions | CC-BY-SA-3.0 | `import:wiktionary` |
| [Kaikki](https://kaikki.org) (kowiktionary/zhwiktionary) | Korean/Chinese definitions | CC-BY-SA-3.0 | `import:kaikki` |
| [Wadoku](https://github.com/WaDoku/WaDokuJT-Data) | German definitions | CC-BY-SA-3.0 | `import:wadoku` |
| [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) | JLPT N5-N1 levels | Public Domain | `import:jlpt` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATA PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│   │   IMPORT     │    │   BUILD      │    │   SERVE      │     │
│   │              │    │              │    │              │     │
│   │ JMdict JSON  │───▶│ data/*.json  │───▶│ dict.sqlite  │     │
│   │ Kaikki JSONL │    │              │    │              │     │
│   │ Tatoeba TSV  │    │ ~130MB JSON  │    │ ~131MB SQLite│     │
│   │ Wiktionary   │    │              │    │              │     │
│   │ Wadoku/JLPT  │    │              │    │ ~1ms lookup  │     │
│   └──────────────┘    └──────────────┘    └──────────────┘     │
│         ▲                    ▲                   ▲              │
│         │                    │                   │              │
│    ┌────┴────┐          ┌────┴────┐        ┌────┴────┐         │
│    │ Scripts │          │ Scripts │        │   API   │         │
│    │ import/*│          │build-db │        │  Hono   │         │
│    └─────────┘          └─────────┘        └─────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why Two-Stage Pipeline?

| Stage | Benefit |
|-------|---------|
| **Import** | Download once, cache raw data, convert to unified JSON format |
| **Build** | Fast SQLite generation, supports incremental updates, debuggable |

The intermediate JSON format allows:
- **Multi-source merging** - Combine JMdict + Wiktionary + manual entries
- **Language-specific builds** - Build only languages you need
- **Diff support** - Preview changes with `--mode diff` before applying
- **Git LFS storage** - Track dictionary data in version control

### Database Schema

```sql
-- Core word data (shared across languages)
CREATE TABLE words (
  id TEXT PRIMARY KEY,          -- "word:reading" format
  word TEXT NOT NULL,           -- Kanji form
  reading TEXT NOT NULL,        -- Hiragana
  part_of_speech TEXT NOT NULL, -- JSON array
  common INTEGER DEFAULT 0,     -- 1 = common word flag
  jlpt TEXT                     -- JSON array [5,4,3,2,1]
);

-- Per-language translations
CREATE TABLE translations (
  word_id TEXT NOT NULL,
  lang TEXT NOT NULL,           -- "en", "de", etc.
  definitions TEXT NOT NULL,    -- JSON array
  sources TEXT NOT NULL,        -- ["jmdict", "wiktionary"]
  PRIMARY KEY (word_id, lang)
);

-- Example sentences
CREATE TABLE examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  japanese TEXT NOT NULL,
  translation TEXT NOT NULL,
  source TEXT NOT NULL
);
```

---

## Development

### Project Structure

```
yori-dict/
├── src/
│   ├── index.ts          # Hono API server
│   ├── db.ts             # SQLite queries
│   ├── types.ts          # TypeScript types
│   └── conjugator.ts     # Verb conjugation engine
├── sdk/                  # Generated TypeScript client (do not edit manually)
│   ├── index.ts          # Re-exports everything
│   ├── types.gen.ts      # Generated types (LookupResponse, Conjugations, etc.)
│   ├── sdk.gen.ts        # Generated service functions (lookupWord, healthCheck)
│   ├── client.gen.ts     # Client factory
│   ├── client/           # Fetch client implementation
│   └── core/             # Serialization, auth, SSE utilities
├── scripts/
│   ├── import/
│   │   ├── base.ts       # Shared types & merge logic
│   │   ├── jmdict.ts     # JMdict importer
│   │   ├── kaikki.ts     # Korean/Chinese definitions
│   │   ├── jlpt.ts       # JLPT level importer
│   │   ├── tatoeba.ts    # Example sentences
│   │   ├── wadoku.ts     # German definitions
│   │   └── wiktionary.ts # English definitions enrichment
│   ├── build-db.ts       # JSON → SQLite compiler
│   ├── pull-data.ts      # Git LFS materializer
│   ├── verify-dict.ts    # Dictionary quality checker
│   ├── cleanup-dict.ts   # Dictionary cleanup (dedup, fix artifacts)
│   └── add.ts            # Manual entry CLI
├── tests/
│   ├── api.test.ts            # API endpoint tests
│   ├── conjugator.test.ts     # Conjugation engine tests
│   ├── import-base.test.ts    # Import merge logic tests
│   ├── import-kaikki.test.ts  # Kaikki parser tests
│   └── build-db.test.ts       # DB build pipeline tests
├── data/
│   ├── en.json           # English dictionary (Git LFS)
│   ├── de.json           # German dictionary (Git LFS)
│   ├── ko.json           # Korean dictionary (Git LFS)
│   ├── zh-cn.json        # Chinese Simplified dictionary (Git LFS)
│   ├── zh-tw.json        # Chinese Traditional dictionary (Git LFS)
│   └── cache/            # Downloaded raw data (gitignored)
├── openapi.yaml          # OpenAPI 3.0 spec (source of truth for SDK codegen)
├── openapi-ts.config.ts  # SDK codegen config (@hey-api/openapi-ts)
└── dict.sqlite           # Built database (gitignored)
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start production server |
| `bun run test` | Run test suite |
| `bun run rebuild:all` | Full rebuild: base imports + enrichment + build:db |
| `bun run import:base` | Run all base importers (jmdict + kaikki, `--mode replace`) |
| `bun run import:enrichment` | Run all enrichment importers (jlpt, tatoeba, wadoku, wiktionary) |
| `bun run import:jmdict --lang en,de` | Import JMdict base dictionary |
| `bun run import:kaikki` | Import Korean/Chinese definitions from Kaikki |
| `bun run import:jlpt` | Import JLPT N5-N1 levels |
| `bun run import:tatoeba` | Import example sentences (all languages) |
| `bun run import:wadoku` | Import Wadoku German definitions |
| `bun run import:wiktionary` | Import Wiktionary definitions |
| `bun run build:db` | Build SQLite from JSON files |
| `bun run verify:dict <path>` | Check dictionary for duplicates and artifacts |
| `bun run cleanup:dict <path>` | Fix duplicates and artifacts (add `--apply` to write) |
| `bun run data:pull` | Pull dictionary files from Git LFS |
| `bun run add` | Add manual dictionary entries |
| `bun run sdk:generate` | Regenerate `sdk/` from `openapi.yaml` |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_PATH` | `./dict.sqlite` | SQLite database path |

---

## SDK

A generated TypeScript client lives in `sdk/`. It's committed to the repo and requires no publish step.

### Usage

**1. Copy or reference `sdk/` in your project.**

If this repo is a monorepo dependency, import directly. Otherwise copy the `sdk/` directory into your project.

**2. Configure the base URL once:**

```ts
import { client } from './sdk'

client.setConfig({ baseUrl: 'https://yori-dict-production.up.railway.app' })
```

**3. Call `lookupWord` with full type safety:**

```ts
import { lookupWord } from './sdk'

const { data, error } = await lookupWord({
  query: { word: '食べる', lang: 'en' },
})

if (data) {
  console.log(data.word)        // '食べる'
  console.log(data.definitions) // ['to eat', ...]
  console.log(data.conjugations?.polite) // 'たべます'
}
```

All request parameters and response shapes are fully typed from the OpenAPI spec. The `lang` parameter accepts `'en' | 'de' | 'ko' | 'zh-CN' | 'zh-TW'` (and lowercase aliases).

### Regenerating

The SDK is auto-generated from `openapi.yaml`. After any API changes, regenerate with:

```bash
bun run sdk:generate
```

---

## Contributing

### Setup for Development

```bash
git clone https://github.com/user/yori-dict.git
cd yori-dict
git lfs install
bun install
bun run data:pull
bun run build:db
bun run dev
```

### Running Tests

```bash
bun test               # Run all 124 tests across 5 files
bun test --watch       # Watch mode
```

**Test files:**

| File | Tests | Covers |
|------|-------|--------|
| `tests/api.test.ts` | 39 | HTTP endpoints, response contracts, multi-language coverage, error handling |
| `tests/conjugator.test.ts` | 29 | Verb/adjective conjugation for all word types |
| `tests/import-base.test.ts` | 34 | Multi-source merge logic, deduplication, import modes |
| `tests/import-kaikki.test.ts` | 20 | Kaikki JSONL parser (Korean/Chinese) |
| `tests/build-db.test.ts` | 2 | SQLite build pipeline smoke test |

Run a single file:
```bash
bun test tests/api.test.ts
bun test tests/conjugator.test.ts
bun test tests/import-base.test.ts
bun test tests/import-kaikki.test.ts
bun test tests/build-db.test.ts
```

### Code Style

- TypeScript strict mode
- No semicolons (Bun default)
- 2-space indentation
- Descriptive variable names

### Adding a New Language

1. Check source support first:
   `en/de`: [scriptin/jmdict-simplified releases](https://github.com/scriptin/jmdict-simplified/releases)
   `ko/zh`: [Kaikki index](https://kaikki.org)
2. Update language definitions and aliases in `src/types.ts`.
3. Add importer mapping in the relevant import script (`scripts/import/jmdict.ts` or `scripts/import/kaikki.ts`).
4. Add example sentence support in `scripts/import/tatoeba.ts` if Tatoeba has a corpus for the language.
5. Import and build:
   ```bash
   bun run rebuild:all
   ```

---

## Deployment

### Docker

```bash
# Materialize LFS files first
bun run data:pull

# Build and run
bun run docker:build
bun run docker:run
```

**Note:** Docker build requires LFS files materialized on host. The Dockerfile uses multi-stage builds for a ~100MB production image.

### Railway

Deployments use GitHub Actions with `railway up`:

1. Add repository secrets:
   - `RAILWAY_TOKEN`
   - `RAILWAY_SERVICE_ID`
2. Disconnect GitHub repo in Railway Dashboard
3. Create a GitHub release to trigger deployment

See `.github/workflows/railway-deployment.yml`

### Other Platforms (Fly.io, Render)

1. Set build command: `bun run build:db`
2. Set start command: `bun run start`
3. Ensure Git LFS files are pulled during build

---

## Troubleshooting

<details>
<summary><b>Build failed: "No language files found"</b></summary>

You need to import data first:
```bash
bun run import:jmdict --lang en
bun run build:db
```
</details>

<details>
<summary><b>Build failed: "SyntaxError: Failed to parse JSON"</b></summary>

The JSON files are still Git LFS pointers:
```bash
bun run data:pull   # Materialize actual files
bun run build:db
```
</details>

<details>
<summary><b>Word not found for common words</b></summary>

Check the database:
```bash
sqlite3 dict.sqlite "SELECT * FROM words WHERE word = '食べる'"
```

If missing, re-import:
```bash
bun run import:jmdict --lang en --mode replace
bun run build:db
```
</details>

<details>
<summary><b>Import modes explained</b></summary>

All import scripts support these modes via `--mode <mode>`:
- `merge` (default): Add new entries/definitions, merge with existing
- `diff`: Preview changes without writing files
- `refresh`: Strip all data from a source and re-import it
- `replace`: Full replace — remove stale keys, then write fresh (base importers only)

Example:
```bash
bun run import:jmdict --lang en --mode diff   # Preview
bun run import:jmdict --lang en --mode merge  # Apply
```
</details>

---

## Import Architecture

Imports are split into two tiers:

**Base importers** — create dictionary entries from scratch (must run first):
- `bun run import:jmdict --lang en,de`  → data/en.json, data/de.json
- `bun run import:kaikki`               → data/ko.json, data/zh-cn.json, data/zh-tw.json

**Enrichment importers** — add data to existing entries (require base imports):
- `bun run import:jlpt`       → adds JLPT levels to all languages
- `bun run import:tatoeba`    → adds example sentences to all languages
- `bun run import:wadoku`     → adds German definitions to de.json
- `bun run import:wiktionary` → adds English definitions to en.json

**Import modes:**

| Script | Default mode | Available modes |
|---|---|---|
| `import:jmdict` | `merge` | `merge`, `diff`, `replace`, `refresh` |
| `import:kaikki` | `merge` | `merge`, `diff`, `replace`, `refresh` |
| `import:jlpt` | `merge` | `merge`, `diff`, `refresh` |
| `import:tatoeba` | `merge` | `merge`, `diff`, `refresh` |
| `import:wadoku` | `merge` | `merge`, `diff`, `refresh` |
| `import:wiktionary` | `merge` | `merge`, `diff`, `refresh` |

**Convenience scripts:**
```bash
bun run import:base        # run all base importers (--mode replace)
bun run import:enrichment  # run all enrichment importers
bun run rebuild:all        # base + enrichment + build:db (full rebuild)
```

---

## License

- **Code & Data**: CC-BY-SA-4.0 (see Data Sources table for individual source licenses)

## Acknowledgments

- [JMdict/EDICT](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) - Original dictionary project
- [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) - Pre-processed JMdict JSON
- [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) - JLPT vocabulary lists
- [Tatoeba](https://tatoeba.org) / [ManyThings.org](https://manythings.org/anki/) / [Tatoeba raw exports](https://downloads.tatoeba.org/exports/per_language/) - Example sentences
- [Wadoku](https://www.wadoku.de) - Japanese-German dictionary
- [Wiktionary](https://kaikki.org) - Wiktionary extracts
- [wanakana](https://github.com/WaniKani/WanaKana) - Japanese text utilities
