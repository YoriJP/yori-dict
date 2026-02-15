# Yori Dict 🈳

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

**Fast, multilingual Japanese dictionary API with automatic verb conjugations.**

- ⚡ **~1ms response time** - SQLite with optimized indexes
- 🌍 **Multilingual** - English, German (extensible to Chinese, Korean)
- 🔤 **Auto conjugations** - ichidan, godan, suru, kuru verbs + i-adjectives
- 📝 **Example sentences** - 60k+ curated examples
- 🎯 **JLPT levels** - N5-N1 tagged for study progress

---

## Quick Try

```bash
# One-liner to start
curl -s "https://api.yori-dict.com/v1/lookup?word=食べる&lang=en" | jq
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
bun run import:jmdict --lang en,de   # Download & process (~5 min)
bun run import:jlpt
bun run import:tatoeba
bun run import:wiktionary
bun run build:db
bun run dev
```

Server runs at `http://localhost:3000`

---

## API Reference

### `GET /v1/lookup`

Lookup a Japanese word by kanji or reading.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `word` | string | ✅ | Japanese word (kanji, hiragana, or katakana) |
| `lang` | string | ❌ | Target language: `en`, `de`, `zh-TW`, `zh-CN`, `ko` (default: `en`) |

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

Health check. Returns `{"status": "ok"}`.

---

## Data Sources & Coverage

| Language | Entries | Examples | JLPT | Sources |
|----------|---------|----------|------|---------|
| **English** | ~215k | ~64k | 7.4k | JMdict, Wiktionary (+60k), Tatoeba |
| **German** | ~128k | - | 7.4k | JMdict, Wadoku (+13k) |
| Chinese (TW) | Planned | - | - | - |
| Chinese (CN) | Planned | - | - | - |
| Korean | Planned | - | - | - |

**Source Details:**

| Source | Data | License | Imported Via |
|--------|------|---------|--------------|
| [JMdict-simplified](https://github.com/scriptin/jmdict-simplified) | Base dictionary | CC-BY-SA-4.0 | `import:jmdict` |
| [Tatoeba](https://tatoeba.org) via [ManyThings](https://manythings.org/anki/) | Example sentences | CC-BY-2.0 | `import:tatoeba` |
| [Wiktionary](https://kaikki.org) | Additional definitions | CC-BY-SA-3.0 | `import:wiktionary` |
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
│   │ JLPT CSV     │    │              │    │              │     │
│   │ Tatoeba TXT  │    │ ~200MB JSON  │    │ ~80MB SQLite │     │
│   │ Wiktionary   │    │              │    │              │     │
│   │ JSONL        │    │              │    │ ~1ms lookup  │     │
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
├── scripts/
│   ├── import/
│   │   ├── base.ts       # Shared types & merge logic
│   │   ├── jmdict.ts     # JMdict importer
│   │   ├── jlpt.ts       # JLPT level importer
│   │   ├── tatoeba.ts    # Example sentences
│   │   ├── wadoku.ts     # German definitions
│   │   └── wiktionary.ts # Wiktionary definitions
│   ├── build-db.ts       # JSON → SQLite compiler
│   ├── pull-data.ts      # Git LFS materializer
│   └── add.ts            # Manual entry CLI
├── data/
│   ├── en.json           # English dictionary (Git LFS)
│   ├── de.json           # German dictionary (Git LFS)
│   └── cache/            # Downloaded raw data
└── dict.sqlite           # Built database (gitignored)
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start production server |
| `bun run test` | Run test suite |
| `bun run import:jmdict --lang en,de` | Import JMdict base dictionary |
| `bun run import:jlpt` | Import JLPT N5-N1 levels |
| `bun run import:tatoeba` | Import example sentences |
| `bun run import:wadoku` | Import Wadoku German definitions |
| `bun run import:wiktionary` | Import Wiktionary definitions |
| `bun run build:db` | Build SQLite from JSON files |
| `bun run data:pull` | Pull dictionary files from Git LFS |
| `bun run add` | Add manual dictionary entries |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_PATH` | `./dict.sqlite` | SQLite database path |

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
bun test              # Run all tests
bun test --watch      # Watch mode
bun test tests/conjugator.test.ts
```

### Code Style

- TypeScript strict mode
- No semicolons (Bun default)
- 2-space indentation
- Descriptive variable names

### Adding a New Language

1. Check JMdict support at [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified/releases)
2. Add language mapping in `scripts/import/jmdict.ts`:
   ```typescript
   const LANG_MAP = { eng: 'en', ger: 'de', fra: 'fr' }
   ```
3. Update `src/types.ts`:
   ```typescript
   export type Language = 'en' | 'de' | 'fr' | 'zh-TW' | 'zh-CN' | 'ko'
   ```
4. Import and build:
   ```bash
   bun run import:jmdict --lang fr
   bun run build:db
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
   - `RAILWAY_PROJECT_ID`
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

All import scripts support three modes:
- `--mode merge` (default): Add new entries, merge with existing
- `--mode diff`: Preview changes without writing files
- `--mode replace`: Full replace (removes stale keys, then writes source snapshot)

Example:
```bash
bun run import:jmdict --lang en --mode diff   # Preview
bun run import:jmdict --lang en --mode merge  # Apply
```
</details>

For more issues, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## License

- **Code**: MIT
- **Data**: Mixed open licenses (see Data Sources table)

## Acknowledgments

- [JMdict/EDICT](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) - Original dictionary project
- [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) - Pre-processed JMdict JSON
- [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) - JLPT vocabulary lists
- [Tatoeba](https://tatoeba.org) / [ManyThings.org](https://manythings.org/anki/) - Example sentences
- [Wadoku](https://www.wadoku.de) - Japanese-German dictionary
- [Wiktionary](https://kaikki.org) - Wiktionary extracts
- [wanakana](https://github.com/WaniKani/WanaKana) - Japanese text utilities
