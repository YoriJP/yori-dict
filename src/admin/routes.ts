import { Hono } from 'hono'
import {
  clearAdminSessionCookie,
  getAdminActor,
  isAdminAuthenticated,
  isAdminEnabled,
  normalizeAdminNextPath,
  requireAdminApiAuth,
  requireAdminPageAuth,
  setAdminSessionCookie,
  verifyAdminPassword,
} from './auth'
import {
  applyBulkReviewAction,
  approveExampleSetReview,
  approveTranslationReview,
  createAdminNewWord,
  getAdminReleaseList,
  getReviewBatchPage,
  getReviewBatchSummary,
  getReviewQueue,
  getAdminSummary,
  getAiReviewQueue,
  getBatchDetail,
  getUpdatesExplorer,
  inspectEntry,
  rejectExampleSetReview,
  rejectTranslationReview,
  runAdminActivateRelease,
  runAdminBuildReleaseForNewWord,
  runAdminBuildRelease,
  runAdminGeminiImport,
  runAdminPromoteRelease,
  runAdminSourceUpdate,
} from './service'
import {
  renderAdminLoginPage,
  renderReviewBatchPage,
  renderDashboardPage,
  renderEntryPage,
  renderJobsPage,
  renderNewWordPage,
  renderReleasesPage,
  renderReviewPage,
  renderUpdatesPage,
} from './views'
import { normalizeLanguage, type Language } from '../types'
import { initUpdatesDatabase, listUpdateBatches } from '../update-store'
import type { GeminiRunOptions } from '../../scripts/import/gemini'
import type { ReviewRiskLevel, ReviewUnitShape } from './types'

const admin = new Hono()
const adminPages = new Hono()
const adminApi = new Hono()

function parseLanguage(raw: string | undefined, fallback: Language = 'en'): Language {
  if (!raw) return fallback
  return normalizeLanguage(raw) ?? fallback
}

function parseLangList(raw: unknown): Language[] | null {
  if (!raw) return null
  const items = Array.isArray(raw) ? raw : String(raw).split(',')
  const langs = items
    .map((value) => normalizeLanguage(String(value).trim()))
    .filter((value): value is Language => value !== null)
  return langs.length > 0 ? langs : null
}

function parseBoolean(raw: unknown, fallback = false): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (raw === 'true') return true
    if (raw === 'false') return false
  }
  return fallback
}

function parseOptionalNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function mapAdminBuildError(
  c: { json: (body: unknown, status?: number) => Response },
  error: unknown
): Response | null {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('Word not found in snapshot:')) {
    return c.json({ error: message }, 404)
  }
  if (message.startsWith('Release version already exists:')) {
    return c.json({ error: message }, 409)
  }
  return null
}

function parseReviewRisk(raw: string | undefined): ReviewRiskLevel | null {
  if (!raw) return null
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : null
}

function parseReviewShape(raw: string | undefined): ReviewUnitShape | null {
  if (!raw) return null
  return raw === 'translation-only' || raw === 'examples-only' ? raw : null
}

function parseOptionalBooleanQuery(raw: string | undefined): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function parseUnitIds(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : []

  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
}

async function readJsonBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  return await request.json() as T
}

admin.get('/admin/login', (c) => {
  const next = normalizeAdminNextPath(c.req.query('next'))
  if (!isAdminEnabled()) {
    return c.html(renderAdminLoginPage({ disabled: true, next }), 503)
  }
  if (isAdminAuthenticated(c)) {
    return c.redirect(next, 302)
  }
  return c.html(renderAdminLoginPage({ next }))
})

admin.post('/admin/login', async (c) => {
  const body = await c.req.parseBody()
  const password = typeof body.password === 'string' ? body.password : ''
  const next = normalizeAdminNextPath(typeof body.next === 'string' ? body.next : null)

  if (!isAdminEnabled()) {
    return c.html(renderAdminLoginPage({ disabled: true, next }), 503)
  }

  if (!verifyAdminPassword(password)) {
    return c.html(renderAdminLoginPage({
      error: 'The access code did not match this environment.',
      next,
    }), 401)
  }

  setAdminSessionCookie(c)
  return c.redirect(next, 303)
})

admin.post('/admin/logout', (c) => {
  clearAdminSessionCookie(c)
  return c.redirect('/admin/login', 303)
})

adminPages.use('/admin', requireAdminPageAuth)
adminPages.use('/admin/*', requireAdminPageAuth)
adminApi.use('/admin/api/*', requireAdminApiAuth)

adminPages.get('/admin', (c) => c.html(renderDashboardPage(getAdminSummary())))

adminPages.get('/admin/entry', (c) => {
  const word = c.req.query('word') ?? ''
  const lang = parseLanguage(c.req.query('lang'))
  return c.html(renderEntryPage(inspectEntry(word, lang)))
})

adminPages.get('/admin/review', (c) => {
  return c.html(renderReviewPage(getReviewQueue({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    risk: parseReviewRisk(c.req.query('risk')),
    shape: parseReviewShape(c.req.query('shape')),
    hasSourceConflict: parseOptionalBooleanQuery(c.req.query('hasSourceConflict')),
    cursor: c.req.query('cursor') ?? null,
    limit: parseOptionalNumber(c.req.query('limit')) ?? 50,
  })))
})

adminPages.get('/admin/review/batch/:id', (c) => {
  return c.html(renderReviewBatchPage(getReviewBatchPage(Number(c.req.param('id')), {
    risk: parseReviewRisk(c.req.query('risk')),
    shape: parseReviewShape(c.req.query('shape')),
    hasSourceConflict: parseOptionalBooleanQuery(c.req.query('hasSourceConflict')),
    cursor: c.req.query('cursor') ?? null,
    limit: parseOptionalNumber(c.req.query('limit')) ?? 50,
  })))
})

adminPages.get('/admin/new-word', (c) => c.html(renderNewWordPage()))

adminPages.get('/admin/releases', (c) => c.html(renderReleasesPage(getAdminReleaseList())))

adminPages.get('/admin/jobs', (c) => {
  const updatesDb = initUpdatesDatabase()
  const batchId = parseOptionalNumber(c.req.query('batchId'))
  const batches = listUpdateBatches(updatesDb, 20)
  updatesDb.close()
  return c.html(renderJobsPage(batches, batchId ? getBatchDetail(batchId) : null))
})

adminPages.get('/admin/updates', (c) => {
  const response = getUpdatesExplorer({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    sourceType: (c.req.query('sourceType') as 'source' | 'ai' | undefined) ?? null,
    status: c.req.query('status') ?? null,
    reviewStatus: (c.req.query('reviewStatus') as 'not_required' | 'pending' | 'approved' | 'rejected' | undefined) ?? null,
  })
  return c.html(renderUpdatesPage(response))
})

adminApi.get('/admin/api/summary', (c) => c.json(getAdminSummary()))
adminApi.get('/admin/api/releases', (c) => c.json(getAdminReleaseList()))
adminApi.get('/admin/api/releases/:version', (c) => {
  const version = c.req.param('version')
  const release = getAdminReleaseList().releases.find((item) => item.version === version) ?? null
  if (!release) return c.json({ error: 'Release not found' }, 404)
  return c.json(release)
})

adminApi.post('/admin/api/releases/build', async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c.req.raw)
  try {
    const result = await runAdminBuildRelease({
      version: typeof body.version === 'string' ? body.version : null,
      activate: parseBoolean(body.activate, true),
      actor: getAdminActor(c),
    })
    return c.json(result)
  } catch (error) {
    const response = mapAdminBuildError(c, error)
    if (response) return response
    throw error
  }
})

adminApi.post('/admin/api/new-word', async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c.req.raw)
  const result = await createAdminNewWord({
    word: typeof body.word === 'string' ? body.word : '',
    reading: typeof body.reading === 'string' ? body.reading : '',
    partOfSpeech: Array.isArray(body.partOfSpeech)
      ? body.partOfSpeech.map((value) => String(value))
      : typeof body.partOfSpeech === 'string'
        ? [body.partOfSpeech]
        : [],
    common: parseBoolean(body.common, false),
    jlpt: parseOptionalNumber(body.jlpt),
    translations: Array.isArray(body.translations)
      ? body.translations.map((row) => ({
          lang: typeof row === 'object' && row && 'lang' in row ? String((row as Record<string, unknown>).lang) as Language : 'en',
          definitions: typeof row === 'object' && row && Array.isArray((row as Record<string, unknown>).definitions)
            ? ((row as Record<string, unknown>).definitions as unknown[]).map((value) => String(value))
            : [],
          examples: typeof row === 'object' && row && Array.isArray((row as Record<string, unknown>).examples)
            ? ((row as Record<string, unknown>).examples as Record<string, unknown>[]).map((item) => ({
                japanese: String(item.japanese ?? ''),
                translation: String(item.translation ?? ''),
              }))
            : [],
        }))
      : [],
  }, getAdminActor(c))

  if (!result.created && result.conflictWordId) return c.json(result, 409)
  if (!result.created) return c.json(result, 400)
  return c.json(result)
})

adminApi.post('/admin/api/new-word/build-release', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const createdWordId = typeof body.createdWordId === 'string' ? body.createdWordId.trim() : ''
  if (!createdWordId) {
    return c.json({ error: 'createdWordId is required.' }, 400)
  }

  try {
    const result = await runAdminBuildReleaseForNewWord({
      createdWordId,
      activate: parseBoolean(body.activate, true),
      actor: getAdminActor(c),
    })
    return c.json(result)
  } catch (error) {
    const response = mapAdminBuildError(c, error)
    if (response) return response
    throw error
  }
})

adminApi.post('/admin/api/releases/:version/activate', (c) => {
  return c.json(runAdminActivateRelease(c.req.param('version'), getAdminActor(c)))
})

adminApi.post('/admin/api/releases/promote', (c) => {
  return c.req.raw.json()
    .catch(() => ({}))
    .then((body: Record<string, unknown>) => {
      try {
        const result = runAdminPromoteRelease({
          version: typeof body.version === 'string' ? body.version : null,
          activate: parseBoolean(body.activate, true),
          actor: getAdminActor(c),
        })
        return c.json(result)
      } catch (error) {
        const response = mapAdminBuildError(c, error)
        if (response) return response
        throw error
      }
    })
})

adminApi.get('/admin/api/entries', (c) => {
  const word = c.req.query('word')
  if (!word) return c.json({ error: 'Missing query parameter: word' }, 400)
  return c.json(inspectEntry(word, parseLanguage(c.req.query('lang'))))
})

adminApi.get('/admin/api/updates', (c) => {
  return c.json(getUpdatesExplorer({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    sourceType: (c.req.query('sourceType') as 'source' | 'ai' | undefined) ?? null,
    status: c.req.query('status') ?? null,
    reviewStatus: (c.req.query('reviewStatus') as 'not_required' | 'pending' | 'approved' | 'rejected' | undefined) ?? null,
  }))
})

adminApi.get('/admin/api/review/ai', (c) => {
  const lang = normalizeLanguage(c.req.query('lang') ?? '')
  return c.json(getAiReviewQueue(lang))
})

adminApi.get('/admin/api/review/queue', (c) => {
  return c.json(getReviewQueue({
    batchId: parseOptionalNumber(c.req.query('batchId')),
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    risk: parseReviewRisk(c.req.query('risk')),
    shape: parseReviewShape(c.req.query('shape')),
    hasSourceConflict: parseOptionalBooleanQuery(c.req.query('hasSourceConflict')),
    cursor: c.req.query('cursor') ?? null,
    limit: parseOptionalNumber(c.req.query('limit')) ?? 50,
  }))
})

adminApi.get('/admin/api/review/batches/:id/summary', (c) => {
  return c.json(getReviewBatchSummary(Number(c.req.param('id'))))
})

adminApi.post('/admin/api/review/translation/:id/approve', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = approveTranslationReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Translation update not found' }, 404)
  return c.json(result)
})

adminApi.post('/admin/api/review/translation/:id/reject', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = rejectTranslationReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Translation update not found' }, 404)
  return c.json(result)
})

adminApi.post('/admin/api/review/example-set/:id/approve', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = approveExampleSetReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Example update set not found' }, 404)
  return c.json(result)
})

adminApi.post('/admin/api/review/example-set/:id/reject', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = rejectExampleSetReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Example update set not found' }, 404)
  return c.json(result)
})

adminApi.post('/admin/api/review/units/approve', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = applyBulkReviewAction('approved', {
    unitIds: parseUnitIds(body.unitIds),
    notes: typeof body.notes === 'string' ? body.notes : null,
    overrideSourceConflict: parseBoolean(body.overrideSourceConflict, false),
  }, getAdminActor(c))

  if (!result.ok) return c.json(result, 400)
  return c.json(result)
})

adminApi.post('/admin/api/review/units/reject', async (c) => {
  const body = await c.req.raw.json().catch(() => ({}))
  const result = applyBulkReviewAction('rejected', {
    unitIds: parseUnitIds(body.unitIds),
    notes: typeof body.notes === 'string' ? body.notes : null,
    overrideSourceConflict: parseBoolean(body.overrideSourceConflict, false),
  }, getAdminActor(c))

  if (!result.ok) return c.json(result, 400)
  return c.json(result)
})

adminApi.post('/admin/api/jobs/source-update', async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c.req.raw)
  const result = await runAdminSourceUpdate({
    langs: parseLangList(body.langs),
    dryRun: parseBoolean(body.dryRun, false),
    actor: getAdminActor(c),
  })
  return c.json(result)
})

adminApi.post('/admin/api/jobs/gemini-import', async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c.req.raw)
  const result = await runAdminGeminiImport({
    actor: getAdminActor(c),
    langs: parseLangList(body.langs) ?? undefined,
    seedLang: typeof body.seedLang === 'string' ? body.seedLang as GeminiRunOptions['seedLang'] : undefined,
    model: typeof body.model === 'string' ? body.model : undefined,
    limit: parseOptionalNumber(body.limit) ?? undefined,
    minFrequency: parseOptionalNumber(body.minFrequency) ?? undefined,
    jlptMax: parseOptionalNumber(body.jlptMax) ?? undefined,
    maxCostUsd: parseOptionalNumber(body.maxCostUsd) ?? undefined,
    commonOnly: parseBoolean(body.commonOnly, false),
    dryRun: parseBoolean(body.dryRun, true),
  })
  return c.json(result)
})

adminApi.get('/admin/api/batches/:id', (c) => {
  return c.json(getBatchDetail(Number(c.req.param('id'))))
})

admin.route('/', adminApi)
admin.route('/', adminPages)

export default admin
