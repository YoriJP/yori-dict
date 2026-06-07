import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { apiReference } from '@scalar/hono-api-reference'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  getCanonicalOverlayOperation,
  listCanonicalOverlayOperations,
  loadCanonicalOverlayFile,
  updateCanonicalOverlayOperation,
} from './domain/overlay-store'
import {
  approveOverlayOperation,
  rejectOverlayOperation,
} from './domain/overlays'
import {
  CanonicalLookupUnavailableError,
  getCanonicalEntry,
  getCanonicalKanji,
  lookupCanonical,
} from './runtime/canonical-db'
import { validateYoriId } from './domain/ids'
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
} from './types'
import type { Language } from './types'
import type { CanonicalLookupInput } from './runtime/canonical-lookup'
import type { ReviewStatus } from './domain/types'

const app = new Hono()

const openapiSpec = readFileSync(resolve(import.meta.dir, '../openapi.yaml'), 'utf-8')

app.use('/v2/*', cors())
app.use('/admin/curation/*', cors())
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

function parseLookupLimit(rawLimit: string | undefined): number | undefined {
  if (!rawLimit) return undefined
  const parsed = Number.parseInt(rawLimit, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, 1), 20)
}

function parseCurationListLimit(rawLimit: string | undefined): number | null | undefined {
  if (!rawLimit) return undefined
  if (!/^\d+$/.test(rawLimit)) return null
  const parsed = Number.parseInt(rawLimit, 10)
  if (parsed < 1 || parsed > 100) return null
  return parsed
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

function optionalLanguage(rawLang: string | undefined): Language | null | undefined {
  if (!rawLang) return undefined
  return normalizeLanguage(rawLang)
}

function parseReviewStatus(value: string | undefined): ReviewStatus | undefined {
  if (!value) return undefined
  if (value === 'unreviewed' || value === 'approved' || value === 'rejected') return value
  return undefined
}

function parseSourceKind(value: string | undefined): 'manual' | 'ai' | undefined {
  if (!value) return undefined
  if (value === 'manual' || value === 'ai') return value
  return undefined
}

function requireCurationOverlayPath(c: Context): string | Response {
  const overlayPath = process.env.CURATION_OVERLAY_PATH?.trim()
  const token = process.env.CURATION_API_TOKEN?.trim()
  if (!overlayPath || !token) return c.json({ error: 'Curation API is not configured' }, 503)

  const authorization = c.req.header('authorization')
  if (authorization !== `Bearer ${token}`) return c.json({ error: 'Unauthorized' }, 401)
  return overlayPath
}

function canonicalEntryOrUnavailable(id: string, lang?: Language) {
  try {
    return getCanonicalEntry(id, lang)
  } catch (error) {
    if (error instanceof CanonicalLookupUnavailableError) {
      return undefined
    }
    throw error
  }
}

function canonicalKanjiOrUnavailable(literal: string, lang?: Language) {
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

function isBatchLookupBody(value: unknown): value is BatchLookupBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return (body.lang === undefined || typeof body.lang === 'string')
    && (body.limit === undefined || typeof body.limit === 'number')
}

app.post('/v2/lookup/batch', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!isBatchLookupBody(body)) {
    return c.json({ error: 'Invalid request body' }, 400)
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
  const lang = optionalLanguage(rawLang)
  if (lang === null) {
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
  const lang = optionalLanguage(rawLang)
  if (lang === null) {
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

app.get('/admin/curation/lookup', (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

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

app.get('/admin/curation/entries/:id', (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

  const id = c.req.param('id')
  if (!validateYoriId('entry', id)) {
    return c.json({ error: 'Invalid entry ID' }, 400)
  }

  const rawLang = c.req.query('lang')
  const lang = optionalLanguage(rawLang)
  if (lang === null) {
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

app.get('/admin/curation/overlays', async (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

  const rawLang = c.req.query('lang')
  const lang = optionalLanguage(rawLang)
  if (lang === null) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  const rawSourceKind = c.req.query('sourceKind')
  const sourceKind = parseSourceKind(rawSourceKind)
  if (rawSourceKind && !sourceKind) return c.json({ error: 'Invalid sourceKind' }, 400)

  const rawReviewStatus = c.req.query('reviewStatus')
  const reviewStatus = parseReviewStatus(rawReviewStatus)
  if (rawReviewStatus && !reviewStatus) return c.json({ error: 'Invalid reviewStatus' }, 400)

  const limit = parseCurationListLimit(c.req.query('limit'))
  if (limit === null) {
    return c.json({ error: 'Invalid limit. Use an integer between 1 and 100.' }, 400)
  }

  const file = await loadCanonicalOverlayFile(overlayPath)
  const operations = listCanonicalOverlayOperations(file, {
    sourceKind,
    reviewStatus,
    lang,
    limit,
  })
  return c.json({ operations, total: operations.length })
})

app.post('/admin/curation/overlays/:id/approve', async (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

  try {
    const operation = await updateCanonicalOverlayOperation(
      overlayPath,
      c.req.param('id'),
      approveOverlayOperation
    )
    return c.json({ operation })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Overlay operation not found:')) {
      return c.json({ error: 'Overlay operation not found' }, 404)
    }
    throw error
  }
})

app.post('/admin/curation/overlays/:id/reject', async (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

  try {
    const operation = await updateCanonicalOverlayOperation(
      overlayPath,
      c.req.param('id'),
      rejectOverlayOperation
    )
    return c.json({ operation })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Overlay operation not found:')) {
      return c.json({ error: 'Overlay operation not found' }, 404)
    }
    if (error instanceof Error && error.message === 'Approved overlay operations cannot be rejected in place') {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

app.get('/admin/curation/overlays/:id', async (c) => {
  const overlayPath = requireCurationOverlayPath(c)
  if (overlayPath instanceof Response) return overlayPath

  const file = await loadCanonicalOverlayFile(overlayPath)
  const operation = getCanonicalOverlayOperation(file, c.req.param('id'))
  if (!operation) return c.json({ error: 'Overlay operation not found' }, 404)
  return c.json({ operation })
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
