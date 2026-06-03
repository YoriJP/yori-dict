import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiReference } from '@scalar/hono-api-reference'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { lookupWord, initSchema } from './db'
import {
  CanonicalLookupUnavailableError,
  getCanonicalEntry,
  getCanonicalKanji,
  lookupCanonical,
} from './runtime/canonical-db'
import { validateYoriId } from './domain/ids'
import adminRoutes from './admin/routes'
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
} from './types'
import type { CanonicalLookupInput } from './runtime/canonical-lookup'

const app = new Hono()

initSchema()

const openapiSpec = readFileSync(resolve(import.meta.dir, '../openapi.yaml'), 'utf-8')

app.use('/v1/*', cors())
app.use('/v2/*', cors())
app.use('/openapi.yaml', cors())

app.get('/openapi.yaml', (c) => {
  return c.text(openapiSpec, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
  })
})

app.get('/docs', apiReference({ url: '/openapi.yaml' }))

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

app.route('/', adminRoutes)

app.get('/v1/lookup', (c) => {
  const word = c.req.query('word')
  const rawLang = c.req.query('lang')
  const lang = rawLang ? normalizeLanguage(rawLang) : 'en'

  if (!word || word.trim() === '') {
    return c.json({ error: 'Missing required parameter: word' }, 400)
  }

  if (!lang) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  const result = lookupWord(word.trim(), lang)

  if (!result) {
    return c.json({ error: 'Word not found' }, 404)
  }

  return c.json(result)
})

function parseLookupLimit(rawLimit: string | undefined): number | undefined {
  if (!rawLimit) return undefined
  const parsed = Number.parseInt(rawLimit, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, 1), 20)
}

function hasLookupQuery(input: Pick<CanonicalLookupInput, 'query' | 'surface' | 'lemma' | 'reading'>): boolean {
  return Boolean(
    input.query?.trim()
    || input.surface?.trim()
    || input.lemma?.trim()
    || input.reading?.trim()
  )
}

function canonicalLookupOrUnavailable(input: CanonicalLookupInput) {
  try {
    return lookupCanonical(input)
  } catch (error) {
    if (error instanceof CanonicalLookupUnavailableError) {
      return null
    }
    throw error
  }
}

function canonicalEntryOrUnavailable(id: string, lang?: NonNullable<ReturnType<typeof normalizeLanguage>>) {
  try {
    return getCanonicalEntry(id, lang)
  } catch (error) {
    if (error instanceof CanonicalLookupUnavailableError) {
      return undefined
    }
    throw error
  }
}

function canonicalKanjiOrUnavailable(literal: string, lang?: NonNullable<ReturnType<typeof normalizeLanguage>>) {
  try {
    return getCanonicalKanji(literal, lang)
  } catch (error) {
    if (error instanceof CanonicalLookupUnavailableError) {
      return undefined
    }
    throw error
  }
}

function isSingleKanjiLiteral(value: string): boolean {
  return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/.test(value)
}

app.get('/v2/lookup', (c) => {
  const rawLang = c.req.query('lang')
  const lang = rawLang ? normalizeLanguage(rawLang) : 'en'
  if (!lang) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  const input: CanonicalLookupInput = {
    query: c.req.query('query') ?? c.req.query('word'),
    surface: c.req.query('surface'),
    lemma: c.req.query('lemma'),
    reading: c.req.query('reading'),
    lang,
    limit: parseLookupLimit(c.req.query('limit')),
  }

  if (!hasLookupQuery(input)) {
    return c.json({ error: 'Missing lookup input. Provide query, word, surface, lemma, or reading.' }, 400)
  }

  const result = canonicalLookupOrUnavailable(input)
  if (!result) {
    return c.json({ error: 'Canonical dictionary is not configured' }, 503)
  }
  if (!result.matched || result.entries.length === 0) {
    return c.json({ error: 'Word not found' }, 404)
  }

  return c.json(result)
})

interface BatchLookupToken {
  query?: string
  word?: string
  surface?: string
  lemma?: string
  reading?: string
  pos?: string
}

interface BatchLookupBody {
  lang?: string
  limit?: number
  tokens?: BatchLookupToken[]
}

function isLookupToken(value: unknown): value is BatchLookupToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const token = value as Record<string, unknown>
  return ['query', 'word', 'surface', 'lemma', 'reading', 'pos'].every((key) => {
    const field = token[key]
    return field === undefined || typeof field === 'string'
  })
}

app.post('/v2/lookup/batch', async (c) => {
  let body: BatchLookupBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const lang = body.lang ? normalizeLanguage(body.lang) : 'en'
  if (!lang) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  if (!Array.isArray(body.tokens)) {
    return c.json({ error: 'Missing required body field: tokens' }, 400)
  }
  if (body.tokens.length > 100) {
    return c.json({ error: 'Batch lookup supports at most 100 tokens' }, 400)
  }
  if (!body.tokens.every(isLookupToken)) {
    return c.json({ error: 'Invalid token shape' }, 400)
  }

  const limit = typeof body.limit === 'number'
    ? Math.min(Math.max(Math.trunc(body.limit), 1), 20)
    : undefined

  const results = []
  for (const token of body.tokens) {
    const input: CanonicalLookupInput = {
      query: token.query ?? token.word,
      surface: token.surface,
      lemma: token.lemma,
      reading: token.reading,
      lang,
      limit,
    }

    if (!hasLookupQuery(input)) {
      results.push({ token, matched: null, entries: [] })
      continue
    }

    const result = canonicalLookupOrUnavailable(input)
    if (!result) {
      return c.json({ error: 'Canonical dictionary is not configured' }, 503)
    }

    results.push({ token, ...result })
  }

  return c.json({ results })
})

app.get('/v2/entries/:id', (c) => {
  const id = c.req.param('id')
  if (!validateYoriId('entry', id)) {
    return c.json({ error: 'Invalid entry ID' }, 400)
  }

  const rawLang = c.req.query('lang')
  const lang = rawLang ? normalizeLanguage(rawLang) : undefined
  if (rawLang && !lang) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  const entry = canonicalEntryOrUnavailable(id, lang)
  if (entry === undefined) {
    return c.json({ error: 'Canonical dictionary is not configured' }, 503)
  }
  if (!entry) {
    return c.json({ error: 'Entry not found' }, 404)
  }

  return c.json(entry)
})

app.get('/v2/kanji/:literal', (c) => {
  const literal = decodeURIComponent(c.req.param('literal'))
  if (!isSingleKanjiLiteral(literal)) {
    return c.json({ error: 'Invalid kanji literal' }, 400)
  }

  const rawLang = c.req.query('lang')
  const lang = rawLang ? normalizeLanguage(rawLang) : undefined
  if (rawLang && !lang) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  const kanji = canonicalKanjiOrUnavailable(literal, lang)
  if (kanji === undefined) {
    return c.json({ error: 'Canonical dictionary is not configured' }, 503)
  }
  if (!kanji) {
    return c.json({ error: 'Kanji not found' }, 404)
  }

  return c.json(kanji)
})

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
}

console.log(`Server running on http://localhost:${process.env.PORT || 3000}`)
