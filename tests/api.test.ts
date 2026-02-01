import { describe, test, expect, beforeAll } from 'bun:test'
import app from '../src/index'

// Helper to make requests to the app
async function request(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`))
}

describe('Health Check', () => {
  test('GET /health returns ok', async () => {
    const res = await request('/health')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })
})

describe('GET /v1/lookup - Success Cases', () => {
  test('lookup by kanji (食べる) returns ichidan verb with conjugations', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('食べる')
    expect(body.reading).toBe('たべる')
    expect(body.romaji).toBe('taberu')
    expect(body.partOfSpeech).toContain('ichidan verb')
    expect(body.definitions.length).toBeGreaterThan(0)
    expect(body.conjugations).toBeDefined()
    expect(body.conjugations.polite).toBe('たべます')
    expect(body.conjugations.negative).toBe('たべない')
    expect(body.conjugations.past).toBe('たべた')
    expect(body.conjugations.te).toBe('たべて')
  })

  test('lookup by reading (たべる) works', async () => {
    const res = await request('/v1/lookup?word=たべる')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('食べる')
    expect(body.reading).toBe('たべる')
  })

  test('lookup godan verb (書く) returns conjugations', async () => {
    const res = await request('/v1/lookup?word=書く')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('書く')
    expect(body.partOfSpeech).toContain('godan verb')
    expect(body.conjugations).toBeDefined()
    expect(body.conjugations.te).toBe('かいて')
    expect(body.conjugations.past).toBe('かいた')
  })

  test('lookup noun (猫) has no conjugations', async () => {
    const res = await request('/v1/lookup?word=猫')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('猫')
    expect(body.partOfSpeech).toContain('noun')
    expect(body.conjugations).toBeUndefined()
  })

  test('lookup i-adjective (高い) returns conjugations', async () => {
    const res = await request('/v1/lookup?word=高い')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('高い')
    expect(body.partOfSpeech).toContain('i-adjective')
    expect(body.conjugations).toBeDefined()
    expect(body.conjugations.negative).toBe('たかくない')
    expect(body.conjugations.past).toBe('たかかった')
  })

  test('lookup with lang=de returns German translation', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=de')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    expect(body.word).toBe('食べる')
    expect(body.definitions.length).toBeGreaterThan(0)
    // German definitions should be different from English
  })

  test('response structure has all required fields', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)
    
    const body = await res.json()
    
    // Required fields
    expect(body).toHaveProperty('word')
    expect(body).toHaveProperty('reading')
    expect(body).toHaveProperty('romaji')
    expect(body).toHaveProperty('partOfSpeech')
    expect(body).toHaveProperty('definitions')
    expect(body).toHaveProperty('examples')
    
    // Type checks
    expect(typeof body.word).toBe('string')
    expect(typeof body.reading).toBe('string')
    expect(typeof body.romaji).toBe('string')
    expect(Array.isArray(body.partOfSpeech)).toBe(true)
    expect(Array.isArray(body.definitions)).toBe(true)
    expect(Array.isArray(body.examples)).toBe(true)
  })
})

describe('GET /v1/lookup - Error Cases', () => {
  test('missing word parameter returns 400', async () => {
    const res = await request('/v1/lookup')
    expect(res.status).toBe(400)
    
    const body = await res.json()
    expect(body.error).toContain('word')
  })

  test('empty word parameter returns 400', async () => {
    const res = await request('/v1/lookup?word=')
    expect(res.status).toBe(400)
    
    const body = await res.json()
    expect(body.error).toContain('word')
  })

  test('whitespace-only word returns 400', async () => {
    const res = await request('/v1/lookup?word=%20%20')
    expect(res.status).toBe(400)
    
    const body = await res.json()
    expect(body.error).toContain('word')
  })

  test('invalid language returns 400', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=fr')
    expect(res.status).toBe(400)
    
    const body = await res.json()
    expect(body.error).toContain('Invalid language')
  })

  test('word not found returns 404', async () => {
    const res = await request('/v1/lookup?word=xxxxxxx')
    expect(res.status).toBe(404)
    
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  test('word exists but no translation for language returns 404', async () => {
    // zh-TW has no translations yet
    const res = await request('/v1/lookup?word=食べる&lang=zh-TW')
    expect(res.status).toBe(404)
  })
})

describe('404 Handler', () => {
  test('unknown route returns 404', async () => {
    const res = await request('/unknown-route')
    expect(res.status).toBe(404)
    
    const body = await res.json()
    expect(body.error).toBe('Not found')
  })

  test('POST to lookup returns 404 (only GET allowed)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/lookup?word=食べる', { method: 'POST' })
    )
    expect(res.status).toBe(404)
  })
})
