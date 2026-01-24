/**
 * Sample seed script - Creates a small sample database for testing
 * 
 * Usage: bun run scripts/seed-sample.ts
 */

import { Database } from 'bun:sqlite'
import { existsSync, unlinkSync } from 'fs'

const DB_PATH = './dict.sqlite'

// Sample data for testing
const SAMPLE_WORDS = [
  {
    id: '1358280',
    word: '食べる',
    reading: 'たべる',
    partOfSpeech: ['ichidan verb', 'transitive verb'],
    common: true,
    translations: {
      en: ['to eat'],
      de: ['essen'],
      'zh-TW': ['吃'],
      'zh-CN': ['吃'],
      ko: ['먹다'],
    },
    examples: {
      en: [
        { japanese: '私は朝ごはんを食べる', translation: 'I eat breakfast' },
        { japanese: '何を食べたいですか', translation: 'What do you want to eat?' },
      ],
      de: [
        { japanese: '私は朝ごはんを食べる', translation: 'Ich esse Frühstück' },
      ],
      'zh-TW': [
        { japanese: '私は朝ごはんを食べる', translation: '我吃早餐' },
      ],
      'zh-CN': [
        { japanese: '私は朝ごはんを食べる', translation: '我吃早餐' },
      ],
      ko: [
        { japanese: '私は朝ごはんを食べる', translation: '나는 아침밥을 먹는다' },
      ],
    },
  },
  {
    id: '1157170',
    word: '飲む',
    reading: 'のむ',
    partOfSpeech: ['godan verb', 'transitive verb'],
    common: true,
    translations: {
      en: ['to drink', 'to swallow'],
      de: ['trinken'],
      'zh-TW': ['喝'],
      'zh-CN': ['喝'],
      ko: ['마시다'],
    },
    examples: {
      en: [
        { japanese: 'お茶を飲む', translation: 'to drink tea' },
      ],
    },
  },
  {
    id: '1310650',
    word: '見る',
    reading: 'みる',
    partOfSpeech: ['ichidan verb', 'transitive verb'],
    common: true,
    translations: {
      en: ['to see', 'to look', 'to watch'],
      de: ['sehen', 'schauen'],
      'zh-TW': ['看'],
      'zh-CN': ['看'],
      ko: ['보다'],
    },
    examples: {
      en: [
        { japanese: 'テレビを見る', translation: 'to watch TV' },
        { japanese: '映画を見る', translation: 'to watch a movie' },
      ],
    },
  },
  {
    id: '1270420',
    word: '書く',
    reading: 'かく',
    partOfSpeech: ['godan verb', 'transitive verb'],
    common: true,
    translations: {
      en: ['to write', 'to draw'],
      de: ['schreiben'],
      'zh-TW': ['寫'],
      'zh-CN': ['写'],
      ko: ['쓰다'],
    },
    examples: {
      en: [
        { japanese: '手紙を書く', translation: 'to write a letter' },
      ],
    },
  },
  {
    id: '1581040',
    word: '行く',
    reading: 'いく',
    partOfSpeech: ['godan verb', 'intransitive verb'],
    common: true,
    translations: {
      en: ['to go', 'to move', 'to proceed'],
      de: ['gehen'],
      'zh-TW': ['去'],
      'zh-CN': ['去'],
      ko: ['가다'],
    },
    examples: {
      en: [
        { japanese: '学校に行く', translation: 'to go to school' },
      ],
    },
  },
  {
    id: '1415510',
    word: '来る',
    reading: 'くる',
    partOfSpeech: ['kuru verb', 'intransitive verb'],
    common: true,
    translations: {
      en: ['to come', 'to arrive'],
      de: ['kommen'],
      'zh-TW': ['來'],
      'zh-CN': ['来'],
      ko: ['오다'],
    },
    examples: {
      en: [
        { japanese: '日本に来る', translation: 'to come to Japan' },
      ],
    },
  },
  {
    id: '1157500',
    word: 'する',
    reading: 'する',
    partOfSpeech: ['suru verb', 'transitive verb'],
    common: true,
    translations: {
      en: ['to do', 'to make'],
      de: ['machen', 'tun'],
      'zh-TW': ['做'],
      'zh-CN': ['做'],
      ko: ['하다'],
    },
    examples: {
      en: [
        { japanese: '勉強する', translation: 'to study' },
        { japanese: '買い物する', translation: 'to go shopping' },
      ],
    },
  },
  {
    id: '1605190',
    word: '美しい',
    reading: 'うつくしい',
    partOfSpeech: ['i-adjective'],
    common: true,
    translations: {
      en: ['beautiful', 'lovely'],
      de: ['schön'],
      'zh-TW': ['美麗'],
      'zh-CN': ['美丽'],
      ko: ['아름답다'],
    },
    examples: {
      en: [
        { japanese: '美しい花', translation: 'beautiful flower' },
      ],
    },
  },
  {
    id: '1188840',
    word: '大きい',
    reading: 'おおきい',
    partOfSpeech: ['i-adjective'],
    common: true,
    translations: {
      en: ['big', 'large'],
      de: ['groß'],
      'zh-TW': ['大'],
      'zh-CN': ['大'],
      ko: ['크다'],
    },
    examples: {
      en: [
        { japanese: '大きい家', translation: 'big house' },
      ],
    },
  },
  {
    id: '1315080',
    word: '猫',
    reading: 'ねこ',
    partOfSpeech: ['noun'],
    common: true,
    translations: {
      en: ['cat'],
      de: ['Katze'],
      'zh-TW': ['貓'],
      'zh-CN': ['猫'],
      ko: ['고양이'],
    },
    examples: {
      en: [
        { japanese: '猫が好きです', translation: 'I like cats' },
      ],
    },
  },
]

function main(): void {
  console.log('=== Creating Sample Database ===\n')

  // Remove existing database
  if (existsSync(DB_PATH)) {
    console.log('Removing existing database...')
    unlinkSync(DB_PATH)
  }

  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      part_of_speech TEXT NOT NULL,
      common INTEGER DEFAULT 0,
      jlpt INTEGER
    );

    CREATE TABLE translations (
      word_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      definitions TEXT NOT NULL,
      source TEXT NOT NULL,
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

  // Insert sample data
  const insertWord = db.prepare(`
    INSERT INTO words (id, word, reading, part_of_speech, common)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertTranslation = db.prepare(`
    INSERT INTO translations (word_id, lang, definitions, source)
    VALUES (?, ?, ?, ?)
  `)

  const insertExample = db.prepare(`
    INSERT INTO examples (word_id, lang, japanese, translation, source)
    VALUES (?, ?, ?, ?, ?)
  `)

  for (const word of SAMPLE_WORDS) {
    // Insert word
    insertWord.run(
      word.id,
      word.word,
      word.reading,
      JSON.stringify(word.partOfSpeech),
      word.common ? 1 : 0
    )

    // Insert translations
    for (const [lang, definitions] of Object.entries(word.translations)) {
      insertTranslation.run(
        word.id,
        lang,
        JSON.stringify(definitions),
        'sample'
      )
    }

    // Insert examples
    for (const [lang, examples] of Object.entries(word.examples)) {
      for (const example of examples) {
        insertExample.run(
          word.id,
          lang,
          example.japanese,
          example.translation,
          'sample'
        )
      }
    }
  }

  // Print stats
  const wordCount = db.query('SELECT COUNT(*) as count FROM words').get() as { count: number }
  console.log(`Inserted ${wordCount.count} words`)

  const langStats = db.query(`
    SELECT lang, COUNT(*) as count 
    FROM translations 
    GROUP BY lang
  `).all() as { lang: string; count: number }[]

  console.log('\nTranslations by language:')
  for (const stat of langStats) {
    console.log(`  ${stat.lang}: ${stat.count}`)
  }

  db.close()

  console.log(`\nDatabase saved to: ${DB_PATH}`)
  console.log('\nRun "bun run dev" to start the API server')
}

main()
