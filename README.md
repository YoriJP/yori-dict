# Yori Dict

Multilingual Japanese dictionary API with verb conjugations.

## Features

- **Fast lookups** - SQLite with indexed queries, ~1ms response time
- **Multilingual** - English, German (extensible to Chinese, Korean)
- **Conjugations** - Auto-generated for ichidan, godan, suru, kuru verbs and i-adjectives
- **Romaji conversion** - Automatic romanization via wanakana
- **CORS enabled** - Ready for browser/frontend integration
- **Two-stage pipeline** - Import to JSON, build to SQLite (debuggable, incremental)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Framework | [Hono](https://hono.dev) |
| Database | SQLite (via bun:sqlite) |
| Data Source | [JMdict-simplified](https://github.com/scriptin/jmdict-simplified) |

## Quick Start

```bash
# Install dependencies
bun install

# Import dictionary data (downloads ~50MB per language)
bun run import:jmdict --lang en,de

# Build SQLite database
bun run build:db

# Start server
bun run dev
```

Server runs at http://localhost:3000

## API Reference

### `GET /v1/lookup`

Lookup a Japanese word by kanji or reading.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `word` | string | required | Japanese word (kanji, hiragana, or katakana) |
| `lang` | string | `en` | Target language: `en`, `de`, `zh-TW`, `zh-CN`, `ko` |

**Example:**

```bash
curl "http://localhost:3000/v1/lookup?word=食べる&lang=en"
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
  "examples": []
}
```

**Errors:**

| Status | Response |
|--------|----------|
| 400 | `{"error": "Missing required parameter: word"}` |
| 400 | `{"error": "Invalid language. Supported: en, de, ..."}` |
| 404 | `{"error": "Word not found"}` |

**Examples behavior:**

- API responses de-duplicate examples by `(japanese, translation)`
- If the same example exists with multiple DB sources, only one example item is returned

### `GET /health`

Health check endpoint. Returns `{"status": "ok"}`.

---

## Architecture

### Data Pipeline Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  STAGE 1        │      │  STAGE 2        │      │  STAGE 3        │
│  IMPORT         │ ──▶  │  BUILD          │ ──▶  │  SERVE          │
│                 │      │                 │      │                 │
│  JMdict JSON    │      │  data/*.json    │      │  dict.sqlite    │
│  → data/en.json │      │  → dict.sqlite  │      │  → API response │
└─────────────────┘      └─────────────────┘      └─────────────────┘
     50MB/lang              ~200MB JSON            ~80MB SQLite
```

### Why Two Stages?

| Benefit | Description |
|---------|-------------|
| **Debuggable** | Inspect `data/en.json` to verify import correctness |
| **Incremental** | Re-run `build:db` without re-downloading data |
| **Multi-source** | Merge data from JMdict, Wadoku, manual entries into same JSON |
| **Diffable** | Use `--mode diff` to preview changes before applying |

### Project Structure

```
yori-dict/
├── src/
│   ├── index.ts          # Hono API server (routes, middleware)
│   ├── db.ts             # SQLite queries & connection management
│   ├── types.ts          # TypeScript types (API, DB rows, etc.)
│   └── conjugator.ts     # Verb/adjective conjugation engine
├── scripts/
│   ├── import/
│   │   ├── base.ts       # Shared types, merge logic, file I/O
│   │   └── jmdict.ts     # JMdict importer
│   ├── build-db.ts       # Compiles JSON → SQLite
│   └── add.ts            # CLI for manual entries
├── data/
│   ├── en.json           # English dictionary (~215k entries)
│   ├── de.json           # German dictionary (~128k entries)
│   └── cache/            # Downloaded JMdict files (gitignored)
├── Dockerfile            # Multi-stage production build
└── dict.sqlite           # Built database (gitignored)
```

---

## Development Guide

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- ~500MB disk space (for dictionary data)

### Setup

```bash
git clone https://github.com/user/yori-dict.git
cd yori-dict
bun install
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start production server |
| `bun run test` | Run test suite |
| `bun run import:jmdict` | Import JMdict data to JSON |
| `bun run build:db` | Build SQLite from JSON files |
| `bun run add` | Add manual dictionary entries |

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/conjugator.test.ts

# Watch mode
bun test --watch
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_PATH` | `./dict.sqlite` | SQLite database path |

---

## Extending the Project

### Adding a New Language

1. **Check JMdict support** - See [available languages](https://github.com/scriptin/jmdict-simplified/releases)

2. **Add language mapping** in `scripts/import/jmdict.ts`:

```typescript
const LANG_MAP: Record<string, string> = {
  eng: 'en',
  ger: 'de',
  fra: 'fr',  // Add French
}

const REVERSE_LANG_MAP: Record<string, string> = {
  en: 'eng',
  de: 'ger',
  fr: 'fra',  // Add French
}
```

3. **Update supported languages** in `src/types.ts`:

```typescript
export type Language = 'en' | 'de' | 'fr' | 'zh-TW' | 'zh-CN' | 'ko'
export const SUPPORTED_LANGUAGES: Language[] = ['en', 'de', 'fr', ...]
```

4. **Import and build**:

```bash
bun run import:jmdict --lang fr
bun run build:db
```

### Adding a New Data Source

Create a new importer in `scripts/import/`. The importer should:

1. Download/load source data
2. Convert to `DictEntry` format
3. Use `mergeDictEntries()` to combine with existing data

`mergeDictEntries()` modes:

- `merge`: add missing keys and merge fields for existing keys
- `diff`: preview `added/updated/unchanged` without mutating entries or writing files
- `replace`: full snapshot sync (remove stale keys not present in source, then overwrite/add source keys)

**Example structure:**

```typescript
// scripts/import/wadoku.ts
import { type DictEntry, loadDict, saveDict, mergeDictEntries } from './base'

async function importWadoku(lang: string): Promise<void> {
  // 1. Load source data
  const sourceData = await fetchWadokuData()

  // 2. Convert to DictEntry format
  const entries: Record<string, DictEntry> = {}
  for (const item of sourceData) {
    const key = `${item.word}:${item.reading}`
    entries[key] = {
      word: item.word,
      reading: item.reading,
      partOfSpeech: item.pos,
      common: false,
      jlpt: [],
      definitions: [{ text: item.meaning, sources: ['wadoku'] }],
      examples: item.example
        ? [{ ja: item.example.ja, text: item.example.text, sources: ['wadoku'] }]
        : [],
    }
  }

  // 3. Merge with existing data
  const dict = await loadDict(`./data/${lang}.json`, lang)
  mergeDictEntries(dict.entries, entries, 'merge')
  await saveDict(`./data/${lang}.json`, dict)
}
```

### Adding Conjugation Forms

Edit `src/conjugator.ts` to add new forms:

```typescript
// Add to Conjugations interface in src/types.ts
export interface Conjugations {
  dictionary: string
  polite: string
  negative: string
  past: string
  te: string
  potential: string   // Add new form
  passive: string     // Add new form
}

// Add conjugation logic in src/conjugator.ts
function conjugateIchidan(reading: string): Conjugations {
  const stem = reading.slice(0, -1)
  return {
    // ... existing forms
    potential: stem + 'られる',
    passive: stem + 'られる',
  }
}
```

---

## Data Formats

### Intermediate JSON (`data/{lang}.json`)

```json
{
  "version": "1.0.0",
  "lang": "en",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "stats": {
    "entries": 214926,
    "withExamples": 0,
    "sources": { "jmdict": 214926 }
  },
  "entries": {
    "食べる:たべる": {
      "word": "食べる",
      "reading": "たべる",
      "partOfSpeech": ["ichidan verb", "transitive verb"],
      "common": true,
      "jlpt": [5],
      "definitions": [
        { "text": "to eat", "sources": ["jmdict"] }
      ],
      "examples": [
        {
          "ja": "毎朝食べます",
          "text": "I eat every morning",
          "sources": ["manual", "tatoeba"]
        }
      ]
    }
  }
}
```

**Key format:** `{word}:{reading}` ensures uniqueness for homonyms.

**Example merge semantics:**

- Examples are deduped by `ja + text`
- If the same `ja + text` appears from multiple importers, `sources` arrays are merged
- Legacy example shape with a single `source` field is normalized on load
- During DB build, one row is inserted per source attribution
- During API lookup, rows are de-duplicated by `(japanese, translation)` before response mapping

### Database Schema

```sql
-- Shared word data (language-independent)
CREATE TABLE words (
  id TEXT PRIMARY KEY,          -- "食べる:たべる"
  word TEXT NOT NULL,           -- "食べる"
  reading TEXT NOT NULL,        -- "たべる"
  part_of_speech TEXT NOT NULL, -- JSON array
  common INTEGER DEFAULT 0,     -- 1 = common word
  jlpt TEXT                     -- JSON array of levels, e.g. [5]
);

-- Translations per language
CREATE TABLE translations (
  word_id TEXT NOT NULL,        -- FK → words.id
  lang TEXT NOT NULL,           -- "en", "de", etc.
  definitions TEXT NOT NULL,    -- JSON array
  sources TEXT NOT NULL,        -- JSON array: ["jmdict", "manual"]
  PRIMARY KEY (word_id, lang)
);

-- Example sentences
CREATE TABLE examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id TEXT NOT NULL,        -- FK → words.id
  lang TEXT NOT NULL,
  japanese TEXT NOT NULL,
  translation TEXT NOT NULL,
  source TEXT NOT NULL          -- one row per source attribution (lookup de-duplicates by pair)
);

-- Indexes
CREATE INDEX idx_words_word ON words(word);
CREATE INDEX idx_words_reading ON words(reading);
```

---

## Deployment

### Docker

```bash
bun run docker:build   # Build image
bun run docker:run     # Run container
```

The Dockerfile uses multi-stage builds:
1. **Builder**: Install deps → build SQLite from JSON
2. **Production**: Copy runtime deps + database only (~100MB image)

### Railway / Fly.io / Render

1. Connect your repository
2. Set build command: `bun run build:db`
3. Set start command: `bun run start`
4. Set `PORT` environment variable (usually auto-set)

---

## Troubleshooting

### Import mode behavior

`import:jmdict` supports three modes:

- `--mode merge` (default): merge new data into existing `data/{lang}.json`
- `--mode diff`: preview changes only (no file writes)
- `--mode replace`: full replace for that language (prunes stale keys, then writes source snapshot)

### Language filtering behavior (JMdict)

JMdict glosses are filtered by requested language during import:

- `en`: accepts `eng` glosses and untagged glosses (JMdict default English)
- non-`en` (for example `de`): accepts only matching tagged glosses (for example `ger`)

This avoids mixed-language definitions in non-English files.

### "No language files found"

```bash
# You need to import data first
bun run import:jmdict --lang en
bun run build:db
```

### "Word not found" for common words

Check if the word exists in the database:

```bash
sqlite3 dict.sqlite "SELECT * FROM words WHERE word = '食べる'"
```

If missing, re-import:

```bash
bun run import:jmdict --lang en --mode replace
bun run build:db
```

### Import fails with network error

JMdict files are cached in `data/cache/`. Delete cache to re-download:

```bash
rm -rf data/cache
bun run import:jmdict --lang en
```

### Database locked errors

Ensure only one process accesses the database. In production, use `DATABASE_PATH` to point to a persistent volume.

### `SQLiteError: no such table: main.words` during `build:db`

If SQLite sidecar files are left over from an interrupted run, clean and rebuild:

```bash
rm -f dict.sqlite dict.sqlite-shm dict.sqlite-wal
bun run build:db
```

---

## Contributing

Contributions are welcome! Here's how to help:

### Good First Issues

- Add support for a new language (French, Spanish, Russian)
- Add more conjugation forms (potential, passive, causative)
- Improve romaji conversion for edge cases
- Add example sentences from Tatoeba

### Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/add-french`
3. Make your changes
4. Run tests: `bun test`
5. Submit a PR with a clear description

### Code Style

- TypeScript strict mode
- No semicolons (Bun default)
- 2-space indentation
- Descriptive variable names

---

## Data Coverage

| Language | Entries | Coverage | Source |
|----------|---------|----------|--------|
| English | 214,926 | 100% | JMdict |
| German | 127,994 | 59.6% | JMdict |

## License

- **Code**: MIT
- **Dictionary data**: [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/) (JMDict/EDRDG)

## Acknowledgments

- [JMdict/EDICT](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) - The original dictionary project
- [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) - Pre-processed JMdict JSON files
- [wanakana](https://github.com/WaniKani/WanaKana) - Japanese text utilities
