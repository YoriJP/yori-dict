/**
 * AI Enrichment Script - Generates translations for missing languages
 * 
 * Usage: 
 *   ANTHROPIC_API_KEY=your_key bun run enrich --lang=zh-TW --limit=100
 * 
 * Options:
 *   --lang     Target language to generate (zh-TW, zh-CN, ko)
 *   --limit    Max number of words to process (default: 100)
 *   --common   Only process common words (default: true)
 *   --dry-run  Don't save to database, just show what would be generated
 */

import { Database } from 'bun:sqlite'
import type { Language } from '../src/types'

const DB_PATH = './dict.sqlite'

// Parse command line arguments
function parseArgs(): { lang: Language; limit: number; commonOnly: boolean; dryRun: boolean } {
  const args = process.argv.slice(2)
  let lang: Language = 'zh-TW'
  let limit = 100
  let commonOnly = true
  let dryRun = false

  for (const arg of args) {
    if (arg.startsWith('--lang=')) {
      lang = arg.split('=')[1] as Language
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.split('=')[1], 10)
    } else if (arg === '--all') {
      commonOnly = false
    } else if (arg === '--dry-run') {
      dryRun = true
    }
  }

  return { lang, limit, commonOnly, dryRun }
}

// Language display names
const LANG_NAMES: Record<string, string> = {
  'zh-TW': 'Traditional Chinese',
  'zh-CN': 'Simplified Chinese',
  'ko': 'Korean',
  'de': 'German',
  'en': 'English',
}

interface WordToEnrich {
  id: string
  word: string
  reading: string
  partOfSpeech: string[]
  englishDefs: string[]
}

interface AIResponse {
  definitions: string[]
  examples: { japanese: string; translation: string }[]
}

/**
 * Get words that need translation for a specific language
 */
function getWordsToEnrich(db: Database, lang: Language, limit: number, commonOnly: boolean): WordToEnrich[] {
  const query = db.query<
    { id: string; word: string; reading: string; part_of_speech: string; definitions: string },
    [string, number]
  >(`
    SELECT w.id, w.word, w.reading, w.part_of_speech, t.definitions
    FROM words w
    JOIN translations t ON w.id = t.word_id AND t.lang = 'en'
    WHERE NOT EXISTS (
      SELECT 1 FROM translations t2 
      WHERE t2.word_id = w.id AND t2.lang = ?
    )
    ${commonOnly ? 'AND w.common = 1' : ''}
    ORDER BY w.common DESC
    LIMIT ?
  `)

  const rows = query.all(lang, limit)

  return rows.map((row) => ({
    id: row.id,
    word: row.word,
    reading: row.reading,
    partOfSpeech: JSON.parse(row.part_of_speech),
    englishDefs: JSON.parse(row.definitions),
  }))
}

/**
 * Build the prompt for AI translation
 */
function buildPrompt(word: WordToEnrich, targetLang: Language): string {
  const langName = LANG_NAMES[targetLang] || targetLang

  return `You are a professional Japanese-${langName} translator. Translate the following Japanese word accurately.

## Word Information
- Japanese: ${word.word}
- Reading: ${word.reading}
- Part of Speech: ${word.partOfSpeech.join(', ')}
- English meaning: ${word.englishDefs.join('; ')}

## Task
Provide a ${langName} translation with:
1. definitions: 1-3 concise translations (most common usage first)
2. examples: 1-2 natural example sentences with translations

## Output Format (JSON only, no markdown)
{
  "definitions": ["translation1", "translation2"],
  "examples": [
    {
      "japanese": "Example sentence in Japanese",
      "translation": "Translation in ${langName}"
    }
  ]
}

Return ONLY the JSON object, no other text.`
}

/**
 * Call Anthropic API to generate translation
 */
async function generateTranslation(word: WordToEnrich, targetLang: Language): Promise<AIResponse | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required')
    process.exit(1)
  }

  const prompt = buildPrompt(word, targetLang)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`API error: ${response.status} - ${error}`)
      return null
    }

    const data = await response.json() as { content: { type: string; text: string }[] }
    const text = data.content[0]?.text

    if (!text) {
      console.error('Empty response from API')
      return null
    }

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('Could not find JSON in response:', text)
      return null
    }

    return JSON.parse(jsonMatch[0]) as AIResponse
  } catch (err) {
    console.error('Error calling API:', err)
    return null
  }
}

/**
 * Save translation to database
 */
function saveTranslation(
  db: Database,
  wordId: string,
  lang: Language,
  response: AIResponse
): void {
  const insertTranslation = db.prepare(`
    INSERT OR REPLACE INTO translations (word_id, lang, definitions, source)
    VALUES (?, ?, ?, ?)
  `)

  const insertExample = db.prepare(`
    INSERT INTO examples (word_id, lang, japanese, translation, source)
    VALUES (?, ?, ?, ?, ?)
  `)

  // Save definitions
  insertTranslation.run(wordId, lang, JSON.stringify(response.definitions), 'ai')

  // Save examples
  for (const example of response.examples) {
    insertExample.run(wordId, lang, example.japanese, example.translation, 'ai')
  }
}

/**
 * Main enrichment function
 */
async function main(): Promise<void> {
  const { lang, limit, commonOnly, dryRun } = parseArgs()

  console.log('=== AI Enrichment Script ===\n')
  console.log(`Target language: ${LANG_NAMES[lang]} (${lang})`)
  console.log(`Limit: ${limit} words`)
  console.log(`Common only: ${commonOnly}`)
  console.log(`Dry run: ${dryRun}\n`)

  const db = new Database(DB_PATH)

  // Get words to enrich
  const words = getWordsToEnrich(db, lang, limit, commonOnly)
  console.log(`Found ${words.length} words needing ${lang} translations\n`)

  if (words.length === 0) {
    console.log('No words to process!')
    db.close()
    return
  }

  // Process words
  let successCount = 0
  let errorCount = 0

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    process.stdout.write(`[${i + 1}/${words.length}] ${word.word} (${word.reading})... `)

    if (dryRun) {
      console.log('(dry run - skipped)')
      continue
    }

    const response = await generateTranslation(word, lang)

    if (response) {
      saveTranslation(db, word.id, lang, response)
      console.log(`OK - ${response.definitions.join(', ')}`)
      successCount++
    } else {
      console.log('FAILED')
      errorCount++
    }

    // Rate limiting - wait 500ms between requests
    if (i < words.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  db.close()

  console.log('\n=== Summary ===')
  console.log(`Success: ${successCount}`)
  console.log(`Errors: ${errorCount}`)
  console.log(`Total: ${words.length}`)
}

// Check for API key before running
if (!process.env.ANTHROPIC_API_KEY && !process.argv.includes('--dry-run')) {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  ANTHROPIC_API_KEY required                                        ║
╠════════════════════════════════════════════════════════════════════╣
║  Set your API key:                                                 ║
║                                                                    ║
║    export ANTHROPIC_API_KEY=your_key_here                          ║
║                                                                    ║
║  Or run with --dry-run to see what would be processed:             ║
║                                                                    ║
║    bun run enrich --lang=zh-TW --dry-run                           ║
╚════════════════════════════════════════════════════════════════════╝
`)
  process.exit(1)
}

main().catch((err) => {
  console.error('Enrichment failed:', err)
  process.exit(1)
})
