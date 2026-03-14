import { describe, expect, test } from 'bun:test'
import { shouldUseKoFallback } from '../scripts/import/kowiktionary-ko'
import type { LangEntry } from '../scripts/import/base'

function makeEntry(definitions: string[], sources: Record<string, string[]>): LangEntry {
  return {
    definitions,
    examples: [],
    _defSources: sources,
  }
}

describe('shouldUseKoFallback', () => {
  test('fills missing entries', () => {
    expect(shouldUseKoFallback(undefined)).toBe(true)
  })

  test('does not override KRDICT-backed entries', () => {
    expect(
      shouldUseKoFallback(makeEntry(['좋다'], { 좋다: ['krdict'] }))
    ).toBe(false)
  })

  test('allows thin non-KRDICT entries', () => {
    expect(
      shouldUseKoFallback(makeEntry(['좋다'], { 좋다: ['ai'] }))
    ).toBe(true)
  })
})
