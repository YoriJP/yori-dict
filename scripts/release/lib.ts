import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'fs'
import { loadCore, loadDict, loadLang, type CoreFile, type DictFile, type LangFile } from '../import/base'
import {
  ReleaseSnapshot,
  ReleaseExampleRecord,
  ReleaseTranslationRecord,
  ReleaseWordRecord,
  createEmptySnapshot,
  createReleaseSchema,
  ensureParentDir,
  makeTranslationKey,
  removeSqliteWithSidecars,
  resolveProjectPath,
} from '../../src/storage'
import { buildExampleMapFromUpdates, buildTranslationMapFromUpdates } from '../../src/update-store'

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1'

interface SnapshotJsonInputs {
  mode: 'new' | 'legacy'
  files: string[]
}

async function assertMaterializedJson(filePath: string): Promise<void> {
  const header = await Bun.file(filePath).slice(0, LFS_POINTER_HEADER.length + 8).text()
  if (header.startsWith(LFS_POINTER_HEADER)) {
    throw new Error(`File "${filePath}" is a Git LFS pointer, not JSON. Run: bun run data:pull`)
  }
}

function addWord(snapshot: ReleaseSnapshot, key: string, record: ReleaseWordRecord): void {
  snapshot.words.set(key, record)
}

function addTranslation(snapshot: ReleaseSnapshot, record: ReleaseTranslationRecord): void {
  snapshot.translations.set(makeTranslationKey(record.wordId, record.lang), record)
}

function addExample(snapshot: ReleaseSnapshot, record: ReleaseExampleRecord): void {
  const key = makeTranslationKey(record.wordId, record.lang)
  const existing = snapshot.examples.get(key) ?? []
  existing.push(record)
  snapshot.examples.set(key, existing)
}

function collectCoreData(core: CoreFile, snapshot: ReleaseSnapshot): void {
  for (const [key, entry] of Object.entries(core.entries)) {
    addWord(snapshot, key, {
      id: key,
      word: entry.word,
      reading: entry.reading,
      partOfSpeech: entry.partOfSpeech,
      common: entry.common,
      jlpt: entry.jlpt !== null ? [entry.jlpt] : [],
      frequency: entry.frequency,
    })
  }
}

function collectLangData(lang: LangFile, snapshot: ReleaseSnapshot): void {
  for (const [key, entry] of Object.entries(lang.entries)) {
    if (!snapshot.words.has(key)) continue

    if (entry.definitions.length > 0) {
      const sourcesSet = new Set<string>()
      for (const sources of Object.values(entry._defSources)) {
        for (const source of sources) sourcesSet.add(source)
      }

      addTranslation(snapshot, {
        wordId: key,
        lang: lang.lang,
        definitions: entry.definitions,
        sources: [...sourcesSet],
      })
    }

    const seenExamples = new Set<string>()
    for (const example of entry.examples) {
      const exampleKey = `${example.ja}\u0000${example.text}\u0000${example.source}`
      if (seenExamples.has(exampleKey)) continue
      seenExamples.add(exampleKey)
      addExample(snapshot, {
        wordId: key,
        lang: lang.lang,
        japanese: example.ja,
        translation: example.text,
        source: example.source || 'unknown',
      })
    }
  }
}

function collectLegacyDictData(dict: DictFile, snapshot: ReleaseSnapshot): void {
  for (const [key, entry] of Object.entries(dict.entries)) {
    const existingWord = snapshot.words.get(key)
    if (!existingWord) {
      addWord(snapshot, key, {
        id: key,
        word: entry.word,
        reading: entry.reading,
        partOfSpeech: entry.partOfSpeech.map((part) => part.value),
        common: entry.common || entry.commonSources.length > 0,
        jlpt: entry.jlpt.map((item) => item.level),
        frequency: entry.frequency?.rank ?? null,
      })
    } else {
      const partOfSpeech = new Set([
        ...existingWord.partOfSpeech,
        ...entry.partOfSpeech.map((part) => part.value),
      ])
      const jlpt = new Set([
        ...existingWord.jlpt,
        ...entry.jlpt.map((item) => item.level),
      ])
      const frequency = entry.frequency?.rank ?? null

      existingWord.partOfSpeech = [...partOfSpeech]
      existingWord.common = existingWord.common || entry.common || entry.commonSources.length > 0
      existingWord.jlpt = [...jlpt].sort((a, b) => b - a)
      if (frequency !== null) {
        existingWord.frequency = existingWord.frequency === null
          ? frequency
          : Math.min(existingWord.frequency, frequency)
      }
    }

    if (entry.definitions.length > 0) {
      const defs = [...new Set(entry.definitions.map((def) => def.text))]
      const sources = [...new Set(entry.definitions.flatMap((def) => def.sources))]
      addTranslation(snapshot, {
        wordId: key,
        lang: dict.lang,
        definitions: defs,
        sources,
      })
    }

    const seenExamples = new Set<string>()
    for (const example of entry.examples) {
      const sources = example.sources.length > 0 ? example.sources : ['unknown']
      for (const source of sources) {
        const exampleKey = `${example.ja}\u0000${example.text}\u0000${source}`
        if (seenExamples.has(exampleKey)) continue
        seenExamples.add(exampleKey)
        addExample(snapshot, {
          wordId: key,
          lang: dict.lang,
          japanese: example.ja,
          translation: example.text,
          source,
        })
      }
    }
  }
}

function resolveSnapshotJsonInputs(): SnapshotJsonInputs {
  const dataDir = resolveProjectPath('data')
  const langDir = resolveProjectPath('data/lang')
  const corePath = resolveProjectPath('data/core.json')
  const newLangFiles = existsSync(langDir)
    ? readdirSync(langDir).filter((file) => file.endsWith('.json') && !file.includes('/'))
    : []

  const legacyLangFiles = existsSync(dataDir)
    ? readdirSync(dataDir).filter((file) => {
      if (!file.endsWith('.json')) return false
      if (file.includes('/')) return false
      if (file === 'core.json') return false
      return true
    })
    : []

  const useNewSchema = existsSync(corePath) && newLangFiles.length > 0
  const useLegacySchema = !useNewSchema && legacyLangFiles.length > 0

  if (!useNewSchema && !useLegacySchema) {
    throw new Error(
      'No dictionary JSON files found. Expected data/core.json + data/lang/*.json or legacy data/{lang}.json.'
    )
  }

  if (useNewSchema) {
    return {
      mode: 'new',
      files: [corePath, ...newLangFiles.map((fileName) => `${langDir}/${fileName}`)],
    }
  }

  return {
    mode: 'legacy',
    files: legacyLangFiles.map((fileName) => `${dataDir}/${fileName}`),
  }
}

export function collectSnapshotSourceFiles(): string[] {
  return resolveSnapshotJsonInputs().files
}

export async function loadSnapshotFromJson(): Promise<ReleaseSnapshot> {
  const snapshot = createEmptySnapshot()

  const inputs = resolveSnapshotJsonInputs()

  if (inputs.mode === 'new') {
    const [corePath, ...langPaths] = inputs.files
    await assertMaterializedJson(corePath)
    const core = await loadCore(corePath)
    collectCoreData(core, snapshot)

    for (const filePath of langPaths) {
      const fileName = filePath.split('/').pop() ?? filePath
      const lang = fileName.replace('.json', '')
      await assertMaterializedJson(filePath)
      const langFile = await loadLang(filePath, lang)
      collectLangData(langFile, snapshot)
    }
  } else {
    for (const filePath of inputs.files) {
      const fileName = filePath.split('/').pop() ?? filePath
      const lang = fileName.replace('.json', '')
      await assertMaterializedJson(filePath)
      const dict = await loadDict(filePath, lang)
      collectLegacyDictData(dict, snapshot)
    }
  }

  return snapshot
}

export function loadSnapshotFromReleaseDb(db: Database): ReleaseSnapshot {
  const snapshot = createEmptySnapshot()

  const wordRows = db.query<{
    id: string
    word: string
    reading: string
    part_of_speech: string
    common: number
    jlpt: string | null
    frequency: number | null
  }, []>(`
    SELECT * FROM words
  `).all()

  for (const row of wordRows) {
    addWord(snapshot, row.id, {
      id: row.id,
      word: row.word,
      reading: row.reading,
      partOfSpeech: JSON.parse(row.part_of_speech) as string[],
      common: row.common === 1,
      jlpt: row.jlpt ? JSON.parse(row.jlpt) as number[] : [],
      frequency: row.frequency,
    })
  }

  const translationRows = db.query<{
    word_id: string
    lang: string
    definitions: string
    sources: string
  }, []>(`
    SELECT * FROM translations
  `).all()

  for (const row of translationRows) {
    addTranslation(snapshot, {
      wordId: row.word_id,
      lang: row.lang,
      definitions: JSON.parse(row.definitions) as string[],
      sources: JSON.parse(row.sources) as string[],
    })
  }

  const exampleRows = db.query<{
    word_id: string
    lang: string
    japanese: string
    translation: string
    source: string
  }, []>(`
    SELECT word_id, lang, japanese, translation, source
    FROM examples
    ORDER BY id
  `).all()

  for (const row of exampleRows) {
    addExample(snapshot, {
      wordId: row.word_id,
      lang: row.lang,
      japanese: row.japanese,
      translation: row.translation,
      source: row.source,
    })
  }

  return snapshot
}

export function applyActiveUpdatesToSnapshot(snapshot: ReleaseSnapshot, updatesDb: Database): ReleaseSnapshot {
  const next = createEmptySnapshot()
  next.words = new Map(snapshot.words)
  next.translations = new Map(snapshot.translations)
  next.examples = new Map(snapshot.examples)

  const translationUpdates = buildTranslationMapFromUpdates(updatesDb)
  for (const [key, value] of translationUpdates) {
    if (!next.words.has(value.wordId)) continue
    next.translations.set(key, value)
  }

  const exampleUpdates = buildExampleMapFromUpdates(updatesDb)
  for (const [key, value] of exampleUpdates) {
    const [wordId] = key.split('\u0000')
    if (!next.words.has(wordId)) continue
    next.examples.set(key, value)
  }

  return next
}

export function writeReleaseSnapshotToDb(
  dbPath: string,
  snapshot: ReleaseSnapshot,
  options: { overwrite?: boolean } = {}
): void {
  ensureParentDir(dbPath)
  const targetExists = ['', '-wal', '-shm'].some((suffix) => existsSync(dbPath + suffix))
  if (targetExists && options.overwrite !== true) {
    throw new Error(`Release DB already exists: ${dbPath}`)
  }
  removeSqliteWithSidecars(dbPath)

  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  createReleaseSchema(db)

  const insertWords = db.prepare(`
    INSERT INTO words (id, word, reading, part_of_speech, common, jlpt, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertTranslations = db.prepare(`
    INSERT INTO translations (word_id, lang, definitions, sources)
    VALUES (?, ?, ?, ?)
  `)
  const insertExamples = db.prepare(`
    INSERT INTO examples (word_id, lang, japanese, translation, source)
    VALUES (?, ?, ?, ?, ?)
  `)

  const writeTransaction = db.transaction(() => {
    for (const [key, word] of snapshot.words) {
      insertWords.run(
        key,
        word.word,
        word.reading,
        JSON.stringify(word.partOfSpeech),
        word.common ? 1 : 0,
        word.jlpt.length > 0 ? JSON.stringify([...word.jlpt].sort((a, b) => b - a)) : null,
        word.frequency,
      )
    }

    for (const translation of snapshot.translations.values()) {
      insertTranslations.run(
        translation.wordId,
        translation.lang,
        JSON.stringify(translation.definitions),
        JSON.stringify(translation.sources),
      )
    }

    for (const examples of snapshot.examples.values()) {
      for (const example of examples) {
        insertExamples.run(
          example.wordId,
          example.lang,
          example.japanese,
          example.translation,
          example.source,
        )
      }
    }
  })

  writeTransaction()
  db.close()
}
