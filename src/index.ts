import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { lookupWord, initSchema } from './db'
import { SUPPORTED_LANGUAGES, type Language } from './types'

const app = new Hono()

// Initialize database schema on startup
initSchema()

// Middleware
app.use('*', cors())

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

// Main lookup endpoint
app.get('/v1/lookup', (c) => {
  // Get query parameters
  const word = c.req.query('word')
  const lang = c.req.query('lang') || 'en'

  // Validate word parameter
  if (!word || word.trim() === '') {
    return c.json({ error: 'Missing required parameter: word' }, 400)
  }

  // Validate language parameter
  if (!SUPPORTED_LANGUAGES.includes(lang as Language)) {
    return c.json(
      { error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` },
      400
    )
  }

  // Lookup word
  const result = lookupWord(word.trim(), lang as Language)

  if (!result) {
    return c.json({ error: 'Word not found' }, 404)
  }

  return c.json(result)
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// Export for Bun
export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
}

console.log(`Server running on http://localhost:${process.env.PORT || 3000}`)
