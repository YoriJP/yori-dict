import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DictFile } from '../scripts/import/base'

/**
 * Builds an in-memory SQLite DB using the same schema as build-db.ts
 * and verifies that a minimal DictFile populates correctly.
 */

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt TEXT
    );
    CREATE TABLE translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      sources TEXT NOT NULL,
      PRIMARY KEY (word_id, lang),
      FOREIGN KEY (word_id) REFERENCES words(id)
    );
    CREATE TABLE examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      japanese TEXT NOT NULL,
      translation TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (word_id) REFERENCES words(id)
    );
    CREATE INDEX idx_words_word ON words(word);
    CREATE INDEX idx_words_reading ON words(reading);
    CREATE INDEX idx_words_common ON words(common);
    CREATE INDEX idx_translations_lang ON translations(lang);
    CREATE INDEX idx_examples_word_id ON examples(word_id);
    CREATE INDEX idx_examples_lang ON examples(lang);
  `)
}

function insertFromDict(db: Database, dict: DictFile): void {
  const insertWord = db.prepare(
    'INSERT INTO words (id, word, reading, part_of_speech, common, jlpt) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const insertTranslation = db.prepare(
    'INSERT INTO translations (word_id, lang, definitions, sources) VALUES (?, ?, ?, ?)'
  )
  const insertExample = db.prepare(
    'INSERT INTO examples (word_id, lang, japanese, translation, source) VALUES (?, ?, ?, ?, ?)'
  )

  for (const [key, entry] of Object.entries(dict.entries)) {
    insertWord.run(
      key,
      entry.word,
      entry.reading,
      JSON.stringify(entry.partOfSpeech),
      entry.common ? 1 : 0,
      entry.jlpt.length > 0 ? JSON.stringify(entry.jlpt) : null
    )

    if (entry.definitions.length > 0) {
      const defs = entry.definitions.map((d) => d.text)
      const sources = [...new Set(entry.definitions.flatMap((d) => d.sources))]
      insertTranslation.run(key, dict.lang, JSON.stringify(defs), JSON.stringify(sources))
    }

    for (const ex of entry.examples) {
      for (const src of ex.sources.length > 0 ? ex.sources : ['unknown']) {
        insertExample.run(key, dict.lang, ex.ja, ex.text, src)
      }
    }
  }
}

// ============================================================================

const testDict: DictFile = {
  version: '1.0.0',
  lang: 'en',
  updatedAt: '2024-01-01T00:00:00Z',
  stats: { entries: 2, withExamples: 1, sources: { jmdict: 2 } },
  entries: {
    '食べる:たべる': {
      word: '食べる',
      reading: 'たべる',
      partOfSpeech: ['ichidan verb'],
      common: true,
      jlpt: [5],
      definitions: [{ text: 'to eat', sources: ['jmdict'] }],
      examples: [{ ja: '猫が食べる', text: 'The cat eats', sources: ['tatoeba'] }],
    },
    '猫:ねこ': {
      word: '猫',
      reading: 'ねこ',
      partOfSpeech: ['noun'],
      common: true,
      jlpt: [4],
      definitions: [{ text: 'cat', sources: ['jmdict'] }],
      examples: [],
    },
  },
}

describe('build-db smoke test', () => {
  test('populates words, translations, and examples from a minimal DictFile', () => {
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    createSchema(db)
    insertFromDict(db, testDict)

    // Words
    const words = db.query('SELECT * FROM words ORDER BY id').all() as any[]
    expect(words).toHaveLength(2)
    expect(words.map((w: any) => w.word).sort()).toEqual(['猫', '食べる'])

    // Translations
    const translations = db.query('SELECT * FROM translations').all() as any[]
    expect(translations).toHaveLength(2)

    // Examples
    const examples = db.query('SELECT * FROM examples').all() as any[]
    expect(examples).toHaveLength(1)
    expect(examples[0].japanese).toBe('猫が食べる')

    db.close()
  })

  test('indexes exist', () => {
    const db = new Database(':memory:')
    createSchema(db)

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[]

    const names = indexes.map((i) => i.name)
    expect(names).toContain('idx_words_word')
    expect(names).toContain('idx_words_reading')
    expect(names).toContain('idx_translations_lang')
    expect(names).toContain('idx_examples_word_id')

    db.close()
  })
})
