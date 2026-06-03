import { describe, expect, test } from 'bun:test'
import {
  createEmptyIdRegistry,
  formatYoriId,
  getOrCreateYoriId,
  registrySectionFor,
  validateYoriId,
} from '../../src/domain/ids'

describe('Yori ID registry', () => {
  test('formats URL-safe product-owned ids', () => {
    expect(formatYoriId('entry', 1)).toBe('yde_00000001')
    expect(formatYoriId('sense', 42)).toBe('yds_00000042')
    expect(formatYoriId('form', 7)).toBe('ydf_00000007')
    expect(formatYoriId('reading', 8)).toBe('ydr_00000008')
    expect(formatYoriId('gloss', 9)).toBe('ydg_00000009')
    expect(formatYoriId('example', 10)).toBe('ydx_00000010')
    expect(formatYoriId('alias', 11)).toBe('yda_00000011')
    expect(formatYoriId('kanji', 12)).toBe('ydk_00000012')
  })

  test('reuses the same Yori id for the same source key', () => {
    const registry = createEmptyIdRegistry()
    const first = getOrCreateYoriId(registry, 'entry', 'jmdict:1358280')
    const second = getOrCreateYoriId(registry, 'entry', 'jmdict:1358280')
    const third = getOrCreateYoriId(registry, 'entry', 'jmdict:1400000')

    expect(first).toBe('yde_00000001')
    expect(second).toBe(first)
    expect(third).toBe('yde_00000002')
    expect(registry.next.entries).toBe(3)
  })

  test('uses separate counters per entity type', () => {
    const registry = createEmptyIdRegistry()

    expect(getOrCreateYoriId(registry, 'entry', 'jmdict:1358280')).toBe('yde_00000001')
    expect(getOrCreateYoriId(registry, 'sense', 'jmdict:1358280:s1')).toBe('yds_00000001')
    expect(getOrCreateYoriId(registry, 'kanji', 'kanjidic2:98df')).toBe('ydk_00000001')
    expect(registrySectionFor('reading')).toBe('readings')
    expect(registrySectionFor('kanji')).toBe('kanjis')
  })

  test('validates ids by entity type', () => {
    expect(validateYoriId('entry', 'yde_00000001')).toBe(true)
    expect(validateYoriId('kanji', 'ydk_00000001')).toBe(true)
    expect(validateYoriId('entry', 'yds_00000001')).toBe(false)
    expect(validateYoriId('entry', 'yd:entry:000001')).toBe(false)
  })
})
