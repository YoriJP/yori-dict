# Yori Dict 🈳

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-CC--BY--SA--4.0-green.svg?style=for-the-badge)](LICENSE)

**Fast, multilingual Japanese dictionary API focused on core vocabulary and kanji-first lookup.**

- ⚡ **~1ms response time** - SQLite with optimized indexes
- 🌍 **Multilingual** - English, German, Korean, Chinese (Simplified & Traditional)
- 🔤 **Auto conjugations** - ichidan, godan, suru, kuru verbs + i-adjectives
- 📝 **Example sentences** - 42k+ unique Japanese examples / 139k+ bilingual pairs from Tatoeba
- 📚 **Core-vocabulary focus** - excludes bulk proper-name imports and prioritizes higher-signal entries
- 🎯 **JLPT levels** - N5-N1 tagged for study progress
- 📊 **Frequency ranks** - JPDB frequency data for 311k+ entries

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
  "frequency": 195,
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
- ~2GB disk space (data cache + JSON files + SQLite)
- Git LFS (`git lfs install`)
- Python 3 + sudachipy (only needed for `import:tatoeba`): `pip install sudachipy sudachidict-core`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` only if you plan to run `import:gemini`

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
bun run rebuild:all  # base imports + deterministic enrichment + build:db
# Optional: AI backfill for missing definitions (SDK-based, not included in rebuild:all)
# bun run import:gemini --langs de,ko,zh-cn,zh-tw --limit 5000
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
| `lang` | string | ❌ | Target language: `en`, `de`, `ko`, `zh-cn`, `zh-tw` (aliases `zh-CN`, `zh-TW`, `zh_cn`, `zh_tw`, `zh-hans`, `zh-hant` accepted; default: `en`) |

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
  "frequency": 195,           // Optional - JPDB rank (1 = most common)
  "conjugations": {           // Optional - only for verbs/adjectives
    "dictionary": "string",
    "polite": "string",
    "negative": "string",
    "past": "string",
    "te": "string"
  },
  "examples": [               // Always present - may be empty
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
| **English** | ~216k | ~49k | JMdict, Wiktionary (+55k defs), Tatoeba |
| **German** | ~129k | ~45k | JMdict, Wadoku (+2.5k defs), Tatoeba |
| **Chinese (CN)** | ~88k | ~18.6k | Kaikki, CC-CEDICT, ZH-JA, Tatoeba (`jpn-cmn`) |
| **Chinese (TW)** | ~88k | ~18.6k | Kaikki, CC-CEDICT, ZH-JA, Tatoeba (`jpn-cmn`, converted to Traditional) |
| **Korean** | ~32k | ~7.7k | KRDICT (NIKL), Tatoeba (`jpn-kor`) |

> **Note:** Entry counts intentionally exclude bulk proper-name imports. This build prioritizes general vocabulary and kanji-bearing dictionary entries over names, places, and company lists.

**Source Details:**

| Source | Data | License | Imported Via |
|--------|------|---------|--------------|
| [JMdict-simplified](https://github.com/scriptin/jmdict-simplified) | Base dictionary (~214k words) | CC-BY-SA-4.0 | `import:jmdict` |
| [Tatoeba](https://tatoeba.org) via [ManyThings](https://manythings.org/anki/) and [raw exports](https://downloads.tatoeba.org/exports/per_language/) | Example sentences | CC-BY-2.0 | `import:tatoeba` (requires `sudachipy`) |
| [Wiktionary](https://kaikki.org) | Additional definitions | CC-BY-SA-3.0 | `import:wiktionary` |
| [Kaikki](https://kaikki.org) (zhwiktionary) | Chinese definitions | CC-BY-SA-3.0 | `import:kaikki` |
| [CC-CEDICT](https://cc-cedict.org) | Chinese character forms for Sino-Japanese vocabulary | CC-BY-SA-4.0 | `import:cedict` |
| ZH-JA Yomitan dictionaries (白水社/中日大辞典/小学館, user-provided) | Chinese definitions for Japanese vocabulary | Licensed (user-supplied) | `import:zhja` |
| [KRDICT](https://krdict.korean.go.kr) (via [yomitan-ko-dic](https://github.com/Lyroxide/yomitan-ko-dic)) | Korean translations | CC-BY-SA-2.0-KR | `import:krdict` |
| [Wadoku](https://github.com/WaDoku/WaDokuJT-Data) | German definitions | CC-BY-SA-3.0 | `import:wadoku` |
| [Google Gemini](https://ai.google.dev/gemini-api/docs) via [`@google/genai`](https://www.npmjs.com/package/@google/genai) | Optional AI backfill for missing definitions | Commercial / API terms apply | `import:gemini` |
| [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) | JLPT N5-N1 levels | Public Domain | `import:jlpt` |
| [JPDB freq list](https://github.com/MarvNC/jpdb-freq-list) | Frequency ranks (~478k entries) | CC-BY-NC-SA-4.0 | `import:frequency` |

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
│   │ JMdict JSON  │───▶│ data/core.json    │──▶│ dict.sqlite │  │
│   │ KRDICT JSON  │    │ data/lang/en.json │   │             │  │
│   │ Kaikki JSONL │    │ data/lang/de.json │   │ ~176MB      │  │
│   │ Tatoeba TSV  │    │ data/lang/ko.json │   │             │  │
│   │ Wiktionary   │    │ data/lang/zh-*    │   │ ~1ms lookup │  │
│   │ Wadoku/JLPT  │    │                   │   │             │  │
│   │ Gemini SDK*  │    │                   │   │             │  │
│   └──────────────┘    │ ~172MB total JSON │   └─────────────┘  │
│         ▲                    ▲                   ▲              │
│         │                    │                   │              │
│    ┌────┴────┐          ┌────┴────┐        ┌────┴────┐         │
│    │ Scripts │          │ Scripts │        │   API   │         │
│    │ import/*│          │build-db │        │  Hono   │         │
│    └─────────┘          └─────────┘        └─────────┘         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

`*` Optional post-processing step for missing definitions only; not part of `rebuild:all`.

### JSON Data Layout

The intermediate JSON is split into two tiers to eliminate duplication (~172MB total vs much larger monolithic per-language files):

```
data/
  core.json           ← language-agnostic: word, reading, POS, common, jlpt, frequency
  lang/
    en.json           ← English definitions + examples
    de.json           ← German definitions + examples
    ko.json           ← Korean definitions + examples
    zh-cn.json        ← Chinese (Simplified) definitions + examples
    zh-tw.json        ← Chinese (Traditional) definitions + examples
  cache/              ← downloaded raw source data (gitignored)
```

**`data/core.json`** — one entry per word, shared across all languages:
```jsonc
{
  "entries": {
    "食べる:たべる": {
      "word": "食べる",
      "reading": "たべる",
      "partOfSpeech": ["ichidan verb", "transitive verb"],
      "common": true,
      "jlpt": 5,          // highest JLPT level (5=N5 easiest, 1=N1 hardest), or null
      "frequency": 195    // JPDB rank (lower = more common), or null
    }
  }
}
```

**`data/lang/*.json`** — definitions and examples per language:
```jsonc
{
  "lang": "en",
  "entries": {
    "食べる:たべる": {
      "definitions": ["to eat", "to live on (e.g. a salary)"],
      "examples": [{ "ja": "毎朝食べます", "text": "I eat every morning", "source": "tatoeba" }],
      "_defSources": {      // pipeline-internal: which source added each definition
        "to eat": ["jmdict"],
        "to live on (e.g. a salary)": ["jmdict"],
        "to dine": ["ai"]
      }
    }
  }
}
```

The `_defSources` field enables selective `--mode refresh` (re-import one source without touching others). Consumers can safely ignore it.

### Schema Compatibility (v2 + legacy)

`build-db` auto-detects input layout:

- **v2 preferred:** `data/core.json` + `data/lang/*.json`
- **legacy fallback:** `data/{lang}.json` (v1 monolithic files)

This allows incremental migration: existing legacy data can still build successfully, while new import flow writes v2 files.

### Why Two-Stage Pipeline?

| Stage | Benefit |
|-------|---------|
| **Import** | Download once, cache raw data, convert to unified JSON format |
| **Build** | Fast SQLite generation, supports incremental updates, debuggable |

The split JSON format allows:
- **Multi-source merging** — combine JMdict + Wiktionary + manual entries per language
- **Source-selective refresh** — re-import one source with `--mode refresh`
- **Diff support** — preview changes with `--mode diff` before applying
- **Git LFS storage** — track dictionary data in version control

### Database Schema

```sql
-- Core word data (shared across languages)
CREATE TABLE words (
  id TEXT PRIMARY KEY,          -- "word:reading" format
  word TEXT NOT NULL,           -- Kanji form
  reading TEXT NOT NULL,        -- Hiragana
  part_of_speech TEXT NOT NULL, -- JSON array of strings
  common INTEGER DEFAULT 0,     -- 1 = common word flag
  jlpt TEXT,                    -- JSON array, e.g. [5] for N5; null if unknown
  frequency INTEGER             -- JPDB rank (1 = most common, NULL if unknown)
);

-- Per-language translations
CREATE TABLE translations (
  word_id TEXT NOT NULL,
  lang TEXT NOT NULL,           -- "en", "de", "ko", "zh-cn", "zh-tw"
  definitions TEXT NOT NULL,    -- JSON array of strings
  sources TEXT NOT NULL,        -- JSON array of source names
  PRIMARY KEY (word_id, lang)
);

-- Example sentences
CREATE TABLE examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  japanese TEXT NOT NULL,
  translation TEXT NOT NULL,
  source TEXT NOT NULL          -- e.g. "tatoeba"
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
│   │   ├── jmdict.ts     # JMdict importer (base vocabulary)
│   │   ├── kaikki.ts     # Chinese definitions (Kaikki/zhwiktionary)
│   │   ├── krdict.ts     # Korean translations (KRDICT/NIKL)
│   │   ├── jlpt.ts       # JLPT level importer
│   │   ├── cedict.ts     # CC-CEDICT Chinese character enrichment
│   │   ├── zhja.ts       # ZH-JA Yomitan reverse-map (Chinese definitions)
│   │   ├── gemini.ts     # Optional Gemini SDK backfill for missing definitions
│   │   ├── frequency.ts  # JPDB frequency rank importer
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
│   ├── core.json         # Language-agnostic word data (Git LFS)
│   ├── lang/
│   │   ├── en.json       # English definitions + examples (Git LFS)
│   │   ├── de.json       # German definitions + examples (Git LFS)
│   │   ├── ko.json       # Korean definitions + examples (Git LFS)
│   │   ├── zh-cn.json    # Chinese Simplified definitions + examples (Git LFS)
│   │   └── zh-tw.json    # Chinese Traditional definitions + examples (Git LFS)
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
| `bun run rebuild:all` | Full deterministic rebuild: base imports + enrichment + build:db |
| `bun run import:base` | Run all base importers (jmdict + kaikki + krdict, `--mode replace`) |
| `bun run import:enrichment` | Run deterministic enrichment importers (jlpt, tatoeba, wadoku, wiktionary, cedict, frequency, zhja) |
| `bun run import:jmdict --lang en,de` | Import JMdict base dictionary |
| `bun run import:kaikki` | Import Chinese definitions from Kaikki (zhwiktionary) |
| `bun run import:krdict` | Import Korean translations from KRDICT (NIKL) |
| `bun run import:gemini` | Optional Gemini SDK backfill for missing definitions |
| `bun run import:jlpt` | Import JLPT N5-N1 levels |
| `bun run import:cedict` | Import CC-CEDICT Chinese character forms (zh-cn, zh-tw) |
| `bun run import:zhja` | Import ZH-JA Yomitan dicts (user-supplied ZIPs → zh-cn, zh-tw) |
| `bun run import:frequency` | Import JPDB frequency ranks (~311k entries matched) |
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
| `GEMINI_API_KEY` | unset | Gemini API key for `import:gemini` |
| `GOOGLE_API_KEY` | unset | Alternative env var accepted by `@google/genai` / `import:gemini` |

---

## SDK

A generated TypeScript client lives in `sdk/`. It's committed to the repo and requires no publish step.

### Usage

**1. Copy or reference `sdk/` in your project.**

If this repo is a monorepo dependency, import directly. Otherwise copy the `sdk/` directory into your project.

**2. Configure the base URL once:**

```ts
import { client } from './sdk/client.gen'

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

All request parameters and response shapes are fully typed from the OpenAPI spec. The `lang` parameter accepts canonical values (`en`, `de`, `ko`, `zh-cn`, `zh-tw`) and the documented aliases (`zh-CN`, `zh-TW`, `zh_cn`, `zh_tw`, `zh-hans`, `zh-hant`).

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
bun test               # Run all tests across 5 files
bun test --watch       # Watch mode
```

**Test files:**

| File | Tests | Covers |
|------|-------|--------|
| `tests/api.test.ts` | 43 | HTTP endpoints, response contracts, multi-language coverage, error handling |
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
   `zh`: [Kaikki index](https://kaikki.org)
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
<summary><b>import:tatoeba fails: "sudachipy not found"</b></summary>

The Tatoeba importer uses [SudachiPy](https://github.com/WorksApplications/SudachiPy) for morphological analysis to correctly match example sentences to dictionary entries. Install it with:

```bash
pip install sudachipy sudachidict-core
```
</details>

<details>
<summary><b>Build failed: "No language files found"</b></summary>

You need to import data first. The build script reads from `data/core.json` and `data/lang/*.json`:
```bash
bun run import:base   # builds core.json + all lang files
bun run build:db
```
</details>

<details>
<summary><b>Build failed: "core.json not found"</b></summary>

Run the base importers first — they create `data/core.json`:
```bash
bun run import:jmdict --lang en
bun run build:db
```
</details>

<details>
<summary><b>Build failed: "SQLiteError: disk I/O error"</b></summary>

Stale WAL sidecar files from a previous interrupted build. The `build:db` script now cleans these up automatically. If you hit this on an older checkout, run:

```bash
rm -f dict.sqlite dict.sqlite-wal dict.sqlite-shm
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
bun run import:jmdict --lang en --mode replace  # writes data/core.json + data/lang/en.json
bun run build:db
```
</details>

<details>
<summary><b>Import modes explained</b></summary>

Importers compare entries by key: `word:reading`.
Use `--mode <mode>` to choose how incoming source data is applied.

| Mode | What it does | Removes old data? | Writes files? |
|---|---|---|---|
| `merge` | Add new keys; merge incoming fields into existing keys | No (keeps unrelated existing keys/data) | Yes |
| `diff` | Run the same comparison as `merge` and print stats only | No | No |
| `refresh` | Remove data from the same source first, then import that source again | Yes (source-scoped) | Yes |
| `replace` | Treat incoming data as full snapshot: prune keys not in source, overwrite keys in source | Yes (snapshot-scoped) | Yes |

How to read this in practice:

- `merge`: safest default for incremental updates.
- `diff`: preview before applying (`added/updated/unchanged`).
- `refresh`: best when one source changed or was imported incorrectly.
- `replace`: full rebuild behavior for that importer's dataset.

Important notes:

- Not every importer supports every mode. Use the mode table below for exact support.
- `replace` is intentionally used mainly by base importers; enrichment importers usually use `merge/diff/refresh`.
- `refresh` behavior depends on importer type:
  - Definition importers: strip only definitions/examples attributed to that source (via `_defSources` and example `source`), then re-merge.
  - Core enrichment importers (`jlpt`, `frequency`): reset the specific core field, then re-apply from source.
  - Example importer (`tatoeba`): remove existing `tatoeba` examples, then re-import examples.

Example:
```bash
bun run import:jmdict --lang en --mode diff   # Preview
bun run import:jmdict --lang en --mode merge  # Apply
```
</details>

---

## Import Architecture

Imports are split into three stages:

**Base importers** — create entries from scratch (must run first):
- `bun run import:jmdict --lang en,de`  → `data/core.json` + `data/lang/en.json`, `data/lang/de.json`
- `bun run import:kaikki`               → `data/lang/zh-cn.json`, `data/lang/zh-tw.json`
- `bun run import:krdict`               → `data/lang/ko.json`

**Deterministic enrichment importers** — add data to existing entries (require base imports):
- `bun run import:jlpt`       → `data/core.json` (JLPT levels, all languages share core)
- `bun run import:frequency`  → `data/core.json` (JPDB frequency ranks)
- `bun run import:tatoeba`    → all `data/lang/*.json` (example sentences)
- `bun run import:wadoku`     → `data/lang/de.json` (German definitions)
- `bun run import:wiktionary` → `data/lang/en.json` (English definitions)
- `bun run import:cedict`     → `data/lang/zh-cn.json`, `data/lang/zh-tw.json` (Chinese character forms)
- `bun run import:zhja`       → `data/lang/zh-cn.json`, `data/lang/zh-tw.json` (user-supplied ZIPs)

**Optional AI backfill** — fills entries that still have missing definitions after deterministic imports:
- `bun run import:gemini --langs de,ko,zh-cn,zh-tw` → writes `ai`-sourced definitions into `data/lang/*.json`

> **Note:** `import:gemini` is intentionally not included in `import:enrichment` or `rebuild:all`. It is API-backed, rate-limited, cost-bearing, and non-deterministic. It uses the official `@google/genai` SDK and requires `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

> **Note:** `import:zhja` requires user-supplied ZIP files placed in `data/cache/` (licensed content, not auto-downloaded): `zhja-hakusuisha.zip`, `zhja-chuunichi.zip`, `zhja-shogakukan.zip`. The script is skipped automatically if no matching ZIPs are present.

**Import modes:**

| Script | Default mode | Available modes |
|---|---|---|
| `import:jmdict` | `merge` | `merge`, `diff`, `replace`, `refresh` |
| `import:kaikki` | `merge` | `merge`, `diff`, `replace`, `refresh` |
| `import:krdict` | `replace` | `merge`, `diff`, `replace`, `refresh` |
| `import:jlpt` | `merge` | `merge`, `diff`, `refresh` |
| `import:tatoeba` | `merge` | `merge`, `diff`, `refresh` |
| `import:wadoku` | `merge` | `merge`, `diff`, `refresh` |
| `import:wiktionary` | `merge` | `merge`, `diff`, `refresh` |
| `import:cedict` | `merge` | `merge`, `diff`, `refresh` |
| `import:zhja` | `merge` | `merge`, `diff`, `refresh` |
| `import:frequency` | `merge` | `merge`, `diff`, `refresh` |
| `import:gemini` | n/a | no import modes; uses `--langs`, `--limit`, `--batch-size`, `--dry-run`, etc. |

**Duplicate-definition conflict policy (where supported):**

Many definition importers support:

- `--dup-policy merge` (default): keep existing + append incoming
- `--dup-policy skip`: keep existing, skip conflicting incoming definitions
- `--dup-policy replace`: replace only conflicting existing definitions, keep unrelated ones
- `--dup-policy ask`: interactive prompt with conflict samples, then choose `skip/replace/merge`

Use `--dup-samples <n>` to control how many conflict examples are shown in `ask` mode.

**Convenience scripts:**
```bash
bun run import:base        # run all base importers (--mode replace)
bun run import:enrichment  # run deterministic enrichment importers only
bun run rebuild:all        # base + deterministic enrichment + build:db
# optional afterwards:
# GEMINI_API_KEY=... bun run import:gemini --langs de,ko,zh-cn,zh-tw
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
- [CC-CEDICT](https://cc-cedict.org) / [MDBG](https://www.mdbg.net) - Chinese-English dictionary
- [KRDICT](https://krdict.korean.go.kr) / [yomitan-ko-dic](https://github.com/Lyroxide/yomitan-ko-dic) - Korean-Japanese dictionary (NIKL)
- [JPDB freq list](https://github.com/MarvNC/jpdb-freq-list) by MarvNC - Frequency data from jpdb.io
- [wanakana](https://github.com/WaniKani/WanaKana) - Japanese text utilities
- [SudachiPy](https://github.com/WorksApplications/SudachiPy) / [SudachiDict](https://github.com/WorksApplications/SudachiDict) - Japanese morphological analyzer (used for example sentence matching)
