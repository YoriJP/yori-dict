import { describe, expect, test } from 'bun:test'
import { cleanupLangEntries } from '../scripts/cleanup-dict'
import type { LangEntry } from '../scripts/import/base'

describe('cleanupLangEntries', () => {
  test('preserves canonical _defSources when removing exact duplicate definitions', () => {
    const entry: LangEntry = {
      definitions: ['to eat', 'to eat'],
      examples: [],
      _defSources: {
        'to eat': ['jmdict'],
      },
    }

    const stats = cleanupLangEntries([entry])

    expect(stats.dupsRemoved).toBe(1)
    expect(entry.definitions).toEqual(['to eat'])
    expect(entry._defSources).toEqual({
      'to eat': ['jmdict'],
    })
  })
})
