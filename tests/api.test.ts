import { describe, test, expect } from 'bun:test'
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
    // 彼処 (あそこ) exists in en but has no zh-tw translation
    const res = await request('/v1/lookup?word=彼処&lang=zh-tw')
    expect(res.status).toBe(404)
  })

  test('canonical lowercase zh code is accepted', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=zh-tw')
    expect(res.status).toBe(200)
  })

  test('zh-CN alias is accepted', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=zh-CN')
    expect(res.status).toBe(200)
  })

  test('ko language is accepted', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=ko')
    expect(res.status).toBe(200)
  })

  test('zh-cn language is accepted for Chinese definitions', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=zh-cn')
    expect(res.status).toBe(200)
  })

  test('zh-tw language is accepted for Traditional Chinese definitions', async () => {
    const res = await request('/v1/lookup?word=食べる&lang=zh-tw')
    expect(res.status).toBe(200)
  })
})

describe('API contract — multi-language coverage', () => {
  // いいえ has translations in all 5 languages under the same word entry
  const langs = ['en', 'de', 'ko', 'zh-cn', 'zh-tw'] as const

  for (const lang of langs) {
    test(`いいえ returns 200 + definitions in ${lang}`, async () => {
      const res = await request(`/v1/lookup?word=いいえ&lang=${lang}`)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.definitions.length).toBeGreaterThan(0)
      expect(Array.isArray(body.examples)).toBe(true)
    })
  }

  test('zh-CN alias returns same data as zh-cn', async () => {
    const [upper, lower] = await Promise.all([
      request('/v1/lookup?word=いいえ&lang=zh-CN').then((r) => r.json()),
      request('/v1/lookup?word=いいえ&lang=zh-cn').then((r) => r.json()),
    ])
    expect(upper.definitions).toEqual(lower.definitions)
  })

  test('zh-TW alias returns same data as zh-tw', async () => {
    const [upper, lower] = await Promise.all([
      request('/v1/lookup?word=いいえ&lang=zh-TW').then((r) => r.json()),
      request('/v1/lookup?word=いいえ&lang=zh-tw').then((r) => r.json()),
    ])
    expect(upper.definitions).toEqual(lower.definitions)
  })

  test('examples have correct shape and no duplicates', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)

    const body = await res.json()
    for (const ex of body.examples) {
      expect(typeof ex.japanese).toBe('string')
      expect(typeof ex.translation).toBe('string')
    }

    const seen = new Set<string>()
    for (const ex of body.examples) {
      expect(seen.has(ex.japanese)).toBe(false)
      seen.add(ex.japanese)
    }
  })
})

describe('API contract — response shape', () => {
  test('definitions array contains only strings (no nulls or objects)', async () => {
    const res = await request('/v1/lookup?word=出る')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.definitions.length).toBeGreaterThan(0)
    for (const def of body.definitions) {
      expect(typeof def).toBe('string')
      expect(def.length).toBeGreaterThan(0)
    }
  })

  test('definitions are deduplicated (no exact string repeats)', async () => {
    // 出る merges 76 definitions from multiple sources — dedup is critical
    const res = await request('/v1/lookup?word=出る')
    expect(res.status).toBe(200)

    const body = await res.json()
    const seen = new Set<string>()
    for (const def of body.definitions) {
      expect(seen.has(def)).toBe(false)
      seen.add(def)
    }
  })

  test('partOfSpeech array contains only non-empty strings', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.partOfSpeech.length).toBeGreaterThan(0)
    for (const pos of body.partOfSpeech) {
      expect(typeof pos).toBe('string')
      expect(pos.length).toBeGreaterThan(0)
    }
  })

  test('reading is valid hiragana/katakana (not empty, not kanji)', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.reading).toBe('たべる')
    expect(body.romaji).toBe('taberu')
  })

  test('conjugations object has all required keys when present', async () => {
    const res = await request('/v1/lookup?word=飲む')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.conjugations).toBeDefined()
    expect(body.conjugations).toHaveProperty('dictionary')
    expect(body.conjugations).toHaveProperty('polite')
    expect(body.conjugations).toHaveProperty('negative')
    expect(body.conjugations).toHaveProperty('past')
    expect(body.conjugations).toHaveProperty('te')
    for (const val of Object.values(body.conjugations)) {
      expect(typeof val).toBe('string')
      expect((val as string).length).toBeGreaterThan(0)
    }
  })

  test('de translation returns different definitions than en', async () => {
    const [en, de] = await Promise.all([
      request('/v1/lookup?word=飲む&lang=en').then((r) => r.json()),
      request('/v1/lookup?word=飲む&lang=de').then((r) => r.json()),
    ])
    expect(en.definitions.length).toBeGreaterThan(0)
    expect(de.definitions.length).toBeGreaterThan(0)
    // German and English definitions should not be identical arrays
    expect(en.definitions).not.toEqual(de.definitions)
  })

  test('noun lookup returns no conjugations field', async () => {
    const res = await request('/v1/lookup?word=猫')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.conjugations).toBeUndefined()
  })

  test('i-adjective returns correct conjugation forms', async () => {
    const res = await request('/v1/lookup?word=大きい')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.conjugations).toBeDefined()
    expect(body.conjugations.negative).toBe('おおきくない')
    expect(body.conjugations.past).toBe('おおきかった')
  })

  test('lookup by reading returns the canonical kanji form', async () => {
    const res = await request('/v1/lookup?word=のむ')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.word).toBe('飲む')
    expect(body.reading).toBe('のむ')
  })

  test('response has no extra undocumented top-level fields', async () => {
    const res = await request('/v1/lookup?word=食べる')
    expect(res.status).toBe(200)

    const body = await res.json()
    const allowedKeys = new Set([
      'word',
      'reading',
      'romaji',
      'partOfSpeech',
      'definitions',
      'examples',
      'conjugations',
      'frequency',
    ])
    for (const key of Object.keys(body)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })
})

describe('GET /openapi.yaml — SDK contract', () => {
  test('returns 200', async () => {
    const res = await request('/openapi.yaml')
    expect(res.status).toBe(200)
  })

  test('Content-Type is text/plain (matches SDK string parse mode)', async () => {
    const res = await request('/openapi.yaml')
    expect(res.headers.get('content-type')).toContain('text/plain')
  })

  test('body is a string (not binary), parseable as YAML text', async () => {
    const res = await request('/openapi.yaml')
    const body = await res.text()
    expect(typeof body).toBe('string')
    expect(body).toContain('openapi:')
    expect(body).toContain('/v1/lookup')
  })

  test('body cannot be parsed as JSON (confirms it is not accidentally JSON)', async () => {
    const res = await request('/openapi.yaml')
    const body = await res.text()
    expect(() => JSON.parse(body)).toThrow()
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
