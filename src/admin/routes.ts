import { Hono } from 'hono'
import { requireAdminAuth, getAdminActor } from './auth'
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
import type { AdminNewWordFormData, ReviewRiskLevel, ReviewUnitShape } from './types'

const admin = new Hono()
type JsonObject = Record<string, unknown>

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

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null
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

async function readJsonObject(request: Request): Promise<JsonObject> {
  const body = await request.json().catch(() => ({}))
  return asObject(body) ?? {}
}

function parseStringList(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
}

function parseNewWordInput(body: JsonObject): AdminNewWordFormData {
  const rawTranslations = Array.isArray(body.translations) ? body.translations : []

  return {
    word: typeof body.word === 'string' ? body.word : '',
    reading: typeof body.reading === 'string' ? body.reading : '',
    partOfSpeech: parseStringList(body.partOfSpeech),
    common: parseBoolean(body.common, false),
    jlpt: parseOptionalNumber(body.jlpt),
    translations: rawTranslations.map((raw): AdminNewWordFormData['translations'][number] => {
      const row = asObject(raw) ?? {}
      const lang = typeof row.lang === 'string'
        ? normalizeLanguage(row.lang) ?? 'en'
        : 'en'

      return {
        lang,
        definitions: parseStringList(row.definitions),
        examples: Array.isArray(row.examples)
          ? row.examples.map((rawExample) => {
              const example = asObject(rawExample) ?? {}
              return {
                japanese: typeof example.japanese === 'string' ? example.japanese : '',
                translation: typeof example.translation === 'string' ? example.translation : '',
              }
            })
          : [],
      }
    }),
  }
}

admin.use('/admin', requireAdminAuth)
admin.use('/admin/*', requireAdminAuth)

admin.get('/admin', (c) => c.html(renderDashboardPage(getAdminSummary())))

admin.get('/admin/entry', (c) => {
  const word = c.req.query('word') ?? ''
  const lang = parseLanguage(c.req.query('lang'))
  return c.html(renderEntryPage(inspectEntry(word, lang)))
})

admin.get('/admin/review', (c) => {
  return c.html(renderReviewPage(getReviewQueue({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    risk: parseReviewRisk(c.req.query('risk')),
    shape: parseReviewShape(c.req.query('shape')),
    hasSourceConflict: parseOptionalBooleanQuery(c.req.query('hasSourceConflict')),
    cursor: c.req.query('cursor') ?? null,
    limit: parseOptionalNumber(c.req.query('limit')) ?? 50,
  })))
})

admin.get('/admin/review/batch/:id', (c) => {
  return c.html(renderReviewBatchPage(getReviewBatchPage(Number(c.req.param('id')), {
    risk: parseReviewRisk(c.req.query('risk')),
    shape: parseReviewShape(c.req.query('shape')),
    hasSourceConflict: parseOptionalBooleanQuery(c.req.query('hasSourceConflict')),
    cursor: c.req.query('cursor') ?? null,
    limit: parseOptionalNumber(c.req.query('limit')) ?? 50,
  })))
})

admin.get('/admin/new-word', (c) => c.html(renderNewWordPage()))

admin.get('/admin/releases', (c) => c.html(renderReleasesPage(getAdminReleaseList())))

admin.get('/admin/jobs', (c) => {
  const updatesDb = initUpdatesDatabase()
  const batchId = parseOptionalNumber(c.req.query('batchId'))
  const batches = listUpdateBatches(updatesDb, 20)
  updatesDb.close()
  return c.html(renderJobsPage(batches, batchId ? getBatchDetail(batchId) : null))
})

admin.get('/admin/updates', (c) => {
  const response = getUpdatesExplorer({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    sourceType: (c.req.query('sourceType') as 'source' | 'ai' | undefined) ?? null,
    status: c.req.query('status') ?? null,
    reviewStatus: (c.req.query('reviewStatus') as 'not_required' | 'pending' | 'approved' | 'rejected' | undefined) ?? null,
  })
  return c.html(renderUpdatesPage(response))
})

admin.get('/admin/api/summary', (c) => c.json(getAdminSummary()))
admin.get('/admin/api/releases', (c) => c.json(getAdminReleaseList()))
admin.get('/admin/api/releases/:version', (c) => {
  const version = c.req.param('version')
  const release = getAdminReleaseList().releases.find((item) => item.version === version) ?? null
  if (!release) return c.json({ error: 'Release not found' }, 404)
  return c.json(release)
})

admin.post('/admin/api/releases/build', async (c) => {
  const body = await readJsonObject(c.req.raw)
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

admin.post('/admin/api/new-word', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = await createAdminNewWord(parseNewWordInput(body), getAdminActor(c))

  if (!result.created && result.conflictWordId) return c.json(result, 409)
  if (!result.created) return c.json(result, 400)
  return c.json(result)
})

admin.post('/admin/api/new-word/build-release', async (c) => {
  const body = await readJsonObject(c.req.raw)
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

admin.post('/admin/api/releases/:version/activate', (c) => {
  return c.json(runAdminActivateRelease(c.req.param('version'), getAdminActor(c)))
})

admin.post('/admin/api/releases/promote', async (c) => {
  const body = await readJsonObject(c.req.raw)
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

admin.get('/admin/api/entries', (c) => {
  const word = c.req.query('word')
  if (!word) return c.json({ error: 'Missing query parameter: word' }, 400)
  return c.json(inspectEntry(word, parseLanguage(c.req.query('lang'))))
})

admin.get('/admin/api/updates', (c) => {
  return c.json(getUpdatesExplorer({
    lang: normalizeLanguage(c.req.query('lang') ?? ''),
    sourceType: (c.req.query('sourceType') as 'source' | 'ai' | undefined) ?? null,
    status: c.req.query('status') ?? null,
    reviewStatus: (c.req.query('reviewStatus') as 'not_required' | 'pending' | 'approved' | 'rejected' | undefined) ?? null,
  }))
})

admin.get('/admin/api/review/ai', (c) => {
  const lang = normalizeLanguage(c.req.query('lang') ?? '')
  return c.json(getAiReviewQueue(lang))
})

admin.get('/admin/api/review/queue', (c) => {
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

admin.get('/admin/api/review/batches/:id/summary', (c) => {
  return c.json(getReviewBatchSummary(Number(c.req.param('id'))))
})

admin.post('/admin/api/review/translation/:id/approve', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = approveTranslationReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Translation update not found' }, 404)
  return c.json(result)
})

admin.post('/admin/api/review/translation/:id/reject', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = rejectTranslationReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Translation update not found' }, 404)
  return c.json(result)
})

admin.post('/admin/api/review/example-set/:id/approve', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = approveExampleSetReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Example update set not found' }, 404)
  return c.json(result)
})

admin.post('/admin/api/review/example-set/:id/reject', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = rejectExampleSetReview(Number(c.req.param('id')), getAdminActor(c), typeof body.notes === 'string' ? body.notes : null)
  if (!result) return c.json({ error: 'Example update set not found' }, 404)
  return c.json(result)
})

admin.post('/admin/api/review/units/approve', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = applyBulkReviewAction('approved', {
    unitIds: parseUnitIds(body.unitIds),
    notes: typeof body.notes === 'string' ? body.notes : null,
    overrideSourceConflict: parseBoolean(body.overrideSourceConflict, false),
  }, getAdminActor(c))

  if (!result.ok) return c.json(result, 400)
  return c.json(result)
})

admin.post('/admin/api/review/units/reject', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = applyBulkReviewAction('rejected', {
    unitIds: parseUnitIds(body.unitIds),
    notes: typeof body.notes === 'string' ? body.notes : null,
    overrideSourceConflict: parseBoolean(body.overrideSourceConflict, false),
  }, getAdminActor(c))

  if (!result.ok) return c.json(result, 400)
  return c.json(result)
})

admin.post('/admin/api/jobs/source-update', async (c) => {
  const body = await readJsonObject(c.req.raw)
  const result = await runAdminSourceUpdate({
    langs: parseLangList(body.langs),
    dryRun: parseBoolean(body.dryRun, false),
    actor: getAdminActor(c),
  })
  return c.json(result)
})

admin.post('/admin/api/jobs/gemini-import', async (c) => {
  const body = await readJsonObject(c.req.raw)
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

admin.get('/admin/api/batches/:id', (c) => {
  return c.json(getBatchDetail(Number(c.req.param('id'))))
})

export default admin
