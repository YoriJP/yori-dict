# Yori Dict

Multilingual Japanese dictionary API with verb conjugations.

## Features

- **Fast lookups** - SQLite database with 214k+ Japanese words
- **Multilingual** - English, German, Chinese (Traditional/Simplified), Korean
- **Conjugations** - Auto-generated for verbs and i-adjectives
- **Romaji conversion** - Automatic romanization of readings
- **CORS enabled** - Ready for frontend integration

## Tech Stack

- **Runtime**: Bun
- **Framework**: Hono
- **Database**: SQLite
- **Data Source**: JMDict

## Setup

```bash
# Install dependencies
bun install

# Seed database (downloads ~110MB, takes ~2 minutes)
bun run seed

# Start development server
bun run dev
```

Server runs at `http://localhost:3000`

## API

### `GET /v1/lookup`

Lookup a Japanese word.

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

| Status | Description |
|--------|-------------|
| 400 | Missing/invalid `word` or unsupported `lang` |
| 404 | Word not found |

### `GET /health`

Health check endpoint.

```json
{ "status": "ok" }
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start production server |
| `bun run test` | Run tests |
| `bun run test:watch` | Run tests in watch mode |
| `bun run db:seed` | Alias for `bun run seed` (build the SQLite database) |
| `bun run seed` | Download and import JMDict data |
| `bun run seed:sample` | Create small test dataset (10 words) |
| `bun run enrich` | Generate AI translations for missing languages |
| `bun run export` | Export dictionary as JSON |

## Testing

```bash
bun test
```

Runs 45 tests covering:

- API endpoints (success and error cases)
- Conjugation logic (ichidan, godan, suru, kuru, i-adjectives)
- Special cases (行く irregular conjugation)

## Frontend Integration

```typescript
const API_BASE = 'http://localhost:3000'

async function lookupWord(word: string, lang = 'en') {
  const res = await fetch(
    `${API_BASE}/v1/lookup?word=${encodeURIComponent(word)}&lang=${lang}`
  )
  if (!res.ok) throw new Error((await res.json()).error)
  return res.json()
}

// Usage
const result = await lookupWord('食べる')
console.log(result.definitions)         // ['to eat', ...]
console.log(result.conjugations?.polite) // 'たべます'
```

See `examples/frontend.ts` for React/Vue integration examples.

## Data Coverage

| Language | Words | Coverage |
|----------|-------|----------|
| English | 214,926 | 100% |
| German | 127,994 | 59.6% |
| Chinese (TW) | 0 | 0% |
| Chinese (CN) | 0 | 0% |
| Korean | 0 | 0% |

Use `bun run enrich` with an Anthropic API key to generate missing translations.

## License

Dictionary data: [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/) (JMDict/EDRDG)
