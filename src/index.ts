import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiReference } from '@scalar/hono-api-reference'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { lookupWord, initSchema } from './db'
import adminRoutes from './admin/routes'
import {
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
} from './types'

const app = new Hono()

initSchema()

const openapiSpec = readFileSync(resolve(import.meta.dir, '../openapi.yaml'), 'utf-8')

app.use('/v1/*', cors())
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
