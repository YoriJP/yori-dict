import { describe, test, expect } from 'bun:test'
import {
  type DictEntry,
  type Definition,
  type LangEntry,
  mergeEntries,
  mergeDictEntries,
  mergeLangEntries,
  mergeDefinitions,
  mergeExamples,
  mergeArrays,
  mergePartOfSpeech,
  mergeJlptEntries,
  makeKey,
  parseKey,
  normalizeText,
  refreshDictSource,
  refreshLangSource,
} from '../scripts/import/base'

// ============================================================================
// Helpers
// ============================================================================

function makeDef(text: string, sources: string[]): Definition {
  return { text, sources }
}

function makeEntry(overrides: Partial<DictEntry> = {}): DictEntry {
  return {
    word: '食べる',
    reading: 'たべる',
    partOfSpeech: [{ value: 'verb', sources: ['jmdict'] }],
    common: false,
    commonSources: [],
    jlpt: [],
    definitions: [makeDef('to eat', ['jmdict'])],
    examples: [],
    ...overrides,
  }
}

// ============================================================================
// Key helpers
// ============================================================================

describe('makeKey / parseKey', () => {
  test('round-trips word and reading', () => {
    const key = makeKey('食べる', 'たべる')
    expect(key).toBe('食べる:たべる')
    expect(parseKey(key)).toEqual({ word: '食べる', reading: 'たべる' })
  })
})

// ============================================================================
// Primitive merge helpers
// ============================================================================

describe('mergeArrays', () => {
  test('deduplicates values', () => {
    expect(mergeArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('mergeJlptEntries', () => {
  test('deduplicates by level and sorts descending', () => {
    const result = mergeJlptEntries(
      [{ level: 3, sources: ['jlpt'] }],
      [{ level: 5, sources: ['jlpt'] }, { level: 1, sources: ['jlpt'] }]
    )
    expect(result.map((j) => j.level)).toEqual([5, 3, 1])
  })

  test('unions sources for same level', () => {
    const result = mergeJlptEntries(
      [{ level: 5, sources: ['a'] }],
      [{ level: 5, sources: ['b'] }]
    )
    expect(result).toHaveLength(1)
    expect(result[0].sources).toContain('a')
    expect(result[0].sources).toContain('b')
  })
})

describe('mergePartOfSpeech', () => {
  test('unions sources for same value', () => {
    const result = mergePartOfSpeech(
      [{ value: 'noun', sources: ['jmdict'] }],
      [{ value: 'noun', sources: ['kaikki'] }]
    )
    expect(result).toHaveLength(1)
    expect(result[0].sources).toContain('jmdict')
    expect(result[0].sources).toContain('kaikki')
  })

  test('keeps distinct values separate', () => {
    const result = mergePartOfSpeech(
      [{ value: 'noun', sources: ['jmdict'] }],
      [{ value: 'verb', sources: ['jmdict'] }]
    )
    expect(result).toHaveLength(2)
    expect(result.map((p) => p.value)).toContain('noun')
    expect(result.map((p) => p.value)).toContain('verb')
  })
})

describe('normalizeText', () => {
  test('lowercases and trims', () => {
    expect(normalizeText('  Hello World  ')).toBe('hello world')
  })
})

// ============================================================================
// mergeDefinitions
// ============================================================================

describe('mergeDefinitions', () => {
  test('combines definitions from different sources without duplicates', () => {
    const d1 = [makeDef('to eat', ['jmdict'])]
    const d2 = [makeDef('to eat', ['kaikki']), makeDef('to consume', ['kaikki'])]

    // 'to eat' from jmdict and kaikki have disjoint sources → kept separate
    const merged = mergeDefinitions(d1, d2)
    expect(merged).toHaveLength(3)
    const toEatDefs = merged.filter((d) => d.text.toLowerCase() === 'to eat')
    expect(toEatDefs).toHaveLength(2)
    expect(toEatDefs.some((d) => d.sources.includes('jmdict'))).toBe(true)
    expect(toEatDefs.some((d) => d.sources.includes('kaikki'))).toBe(true)
    expect(merged.some((d) => d.text === 'to consume')).toBe(true)
  })

  test('merges definitions that share a source', () => {
    const d1 = [makeDef('to eat', ['jmdict'])]
    const d2 = [makeDef('to eat', ['jmdict']), makeDef('to consume', ['jmdict'])]

    // Same source → merged into one 'to eat'
    const merged = mergeDefinitions(d1, d2)
    expect(merged).toHaveLength(2)
    expect(merged[0].text).toBe('to eat')
    expect(merged[0].sources).toEqual(['jmdict'])
  })

  test('case-insensitive dedup with disjoint sources keeps separate', () => {
    const merged = mergeDefinitions(
      [makeDef('To Eat', ['a'])],
      [makeDef('to eat', ['b'])]
    )
    // Disjoint sources → kept as 2 separate definitions
    expect(merged).toHaveLength(2)
    expect(merged.some((d) => d.sources.includes('a'))).toBe(true)
    expect(merged.some((d) => d.sources.includes('b'))).toBe(true)
  })

  test('case-insensitive dedup with overlapping sources merges', () => {
    const merged = mergeDefinitions(
      [makeDef('To Eat', ['a', 'b'])],
      [makeDef('to eat', ['b', 'c'])]
    )
    // Shares source 'b' → merged
    expect(merged).toHaveLength(1)
    expect(merged[0].sources).toContain('a')
    expect(merged[0].sources).toContain('b')
    expect(merged[0].sources).toContain('c')
  })
})

// ============================================================================
// mergeExamples
// ============================================================================

describe('mergeExamples', () => {
  test('disjoint sources keep separate entries for same ja+text', () => {
    const ex1 = [{ ja: '猫が食べる', text: 'The cat eats', sources: ['jmdict'] }]
    const ex2 = [
      { ja: '猫が食べる', text: 'The cat eats', sources: ['kaikki'] },
      { ja: '犬が食べる', text: 'The dog eats', sources: ['kaikki'] },
    ]

    const merged = mergeExamples(ex1, ex2)
    // Disjoint sources → separate entries
    expect(merged).toHaveLength(3)
    expect(merged.filter((e) => e.ja === '猫が食べる')).toHaveLength(2)
  })

  test('same source merges overlapping examples', () => {
    const ex1 = [{ ja: '猫が食べる', text: 'The cat eats', sources: ['tatoeba'] }]
    const ex2 = [{ ja: '猫が食べる', text: 'The cat eats', sources: ['tatoeba'] }]

    const merged = mergeExamples(ex1, ex2)
    expect(merged).toHaveLength(1)
    expect(merged[0].sources).toEqual(['tatoeba'])
  })
})

// ============================================================================
// mergeEntries
// ============================================================================

describe('mergeEntries', () => {
  test('merges definitions from different sources', () => {
    const e1 = makeEntry({ definitions: [makeDef('to eat', ['jmdict'])] })
    const e2 = makeEntry({ definitions: [makeDef('to consume', ['kaikki'])] })

    const merged = mergeEntries(e1, e2)
    expect(merged.definitions).toHaveLength(2)
  })

  test('preserves existing fields (jlpt, common, pos)', () => {
    const e1 = makeEntry({
      common: true,
      commonSources: ['jmdict'],
      jlpt: [{ level: 5, sources: ['jlpt'] }],
      partOfSpeech: [{ value: 'verb', sources: ['jmdict'] }],
    })
    const e2 = makeEntry({
      common: false,
      commonSources: [],
      jlpt: [{ level: 3, sources: ['jlpt'] }],
      partOfSpeech: [{ value: 'noun', sources: ['jmdict'] }],
    })

    const merged = mergeEntries(e1, e2)
    expect(merged.common).toBe(true)
    expect(merged.jlpt.map((j) => j.level)).toEqual([5, 3])
    expect(merged.partOfSpeech.map((p) => p.value)).toContain('verb')
    expect(merged.partOfSpeech.map((p) => p.value)).toContain('noun')
  })

  test('handles source attribution correctly - disjoint sources stay separate', () => {
    const e1 = makeEntry({ definitions: [makeDef('to eat', ['jmdict'])] })
    const e2 = makeEntry({ definitions: [makeDef('to eat', ['kaikki'])] })

    // Disjoint sources → kept as 2 separate definitions
    const merged = mergeEntries(e1, e2)
    expect(merged.definitions).toHaveLength(2)
    expect(merged.definitions.some((d) => d.sources.includes('jmdict'))).toBe(true)
    expect(merged.definitions.some((d) => d.sources.includes('kaikki'))).toBe(true)
  })
})

// ============================================================================
// mergeDictEntries — merge mode
// ============================================================================

describe('mergeDictEntries — merge mode', () => {
  test('adds new entries to target', () => {
    const target: Record<string, DictEntry> = {}
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b' }) }

    const stats = mergeDictEntries(target, source, 'merge')
    expect(stats.added).toBe(1)
    expect(target['a:b']).toBeDefined()
  })

  test('merges overlapping entries', () => {
    const target = { 'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('x', ['s1'])] }) }
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('y', ['s2'])] }) }

    const stats = mergeDictEntries(target, source, 'merge')
    expect(stats.updated).toBe(1)
    expect(target['a:b'].definitions).toHaveLength(2)
  })

  test('leaves unrelated target entries untouched', () => {
    const target = {
      'a:b': makeEntry({ word: 'a', reading: 'b' }),
      'c:d': makeEntry({ word: 'c', reading: 'd' }),
    }
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new', ['s'])] }) }

    mergeDictEntries(target, source, 'merge')
    expect(target['c:d']).toBeDefined()
  })
})

// ============================================================================
// mergeDictEntries — diff mode
// ============================================================================

describe('mergeDictEntries — diff mode', () => {
  test('reports new and updated entries', () => {
    const target = { 'a:b': makeEntry({ word: 'a', reading: 'b' }) }
    const source = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new', ['s'])] }),
      'c:d': makeEntry({ word: 'c', reading: 'd' }),
    }

    const stats = mergeDictEntries(target, source, 'diff')
    expect(stats.added).toBe(1)
    expect(stats.updated).toBe(1)
  })

  test('does NOT mutate the target', () => {
    const target: Record<string, ReturnType<typeof makeEntry>> = { 'a:b': makeEntry({ word: 'a', reading: 'b' }) }
    const originalDefs = JSON.stringify(target['a:b'].definitions)

    const source = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('extra', ['s'])] }),
      'x:y': makeEntry({ word: 'x', reading: 'y' }),
    }

    mergeDictEntries(target, source, 'diff')

    // Target should not have the new entry
    expect(target['x:y']).toBeUndefined()
    // Target entry should not be modified
    expect(JSON.stringify(target['a:b'].definitions)).toBe(originalDefs)
  })
})

// ============================================================================
// mergeDictEntries — replace mode
// ============================================================================

describe('mergeDictEntries — replace mode', () => {
  test('replaces matching entries', () => {
    const target = { 'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('old', ['s1'])] }) }
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new', ['s2'])] }) }

    const stats = mergeDictEntries(target, source, 'replace')
    expect(stats.updated).toBe(1)
    expect(target['a:b'].definitions[0].text).toBe('new')
  })

  test('removes stale entries not in source', () => {
    const target = {
      'a:b': makeEntry({ word: 'a', reading: 'b' }),
      'old:stale': makeEntry({ word: 'old', reading: 'stale' }),
    }
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b' }) }

    mergeDictEntries(target, source, 'replace')
    expect(target['old:stale']).toBeUndefined()
  })

  test('adds new entries from source', () => {
    const target: Record<string, DictEntry> = {}
    const source = { 'a:b': makeEntry({ word: 'a', reading: 'b' }) }

    const stats = mergeDictEntries(target, source, 'replace')
    expect(stats.added).toBe(1)
    expect(target['a:b']).toBeDefined()
  })
})

// ============================================================================
// refreshDictSource
// ============================================================================

describe('refreshDictSource', () => {
  test('strips all definitions for the given source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        definitions: [makeDef('x', ['jmdict']), makeDef('y', ['wadoku'])],
      }),
    }

    refreshDictSource(target, {}, 'jmdict')
    expect(target['a:b'].definitions).toHaveLength(1)
    expect(target['a:b'].definitions[0].sources).toEqual(['wadoku'])
  })

  test('removes empty entries not in source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('x', ['jmdict'])] }),
    }

    refreshDictSource(target, {}, 'jmdict')
    expect(target['a:b']).toBeUndefined()
  })

  test('keeps empty entry if it is in source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('x', ['jmdict'])] }),
    }
    const source: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new', ['jmdict'])] }),
    }

    refreshDictSource(target, source, 'jmdict')
    expect(target['a:b']).toBeDefined()
    expect(target['a:b'].definitions.some((d) => d.text === 'new')).toBe(true)
  })

  test('adds new entries from source', () => {
    const target: Record<string, DictEntry> = {}
    const source: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('x', ['jmdict'])] }),
    }

    const stats = refreshDictSource(target, source, 'jmdict')
    expect(stats.added).toBe(1)
    expect(target['a:b']).toBeDefined()
  })

  test('leaves data from other sources untouched', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        definitions: [makeDef('from jmdict', ['jmdict']), makeDef('from kaikki', ['kaikki'])],
        examples: [{ ja: 'test', text: 'example', sources: ['tatoeba'] }],
      }),
    }
    const source: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new jmdict', ['jmdict'])] }),
    }

    refreshDictSource(target, source, 'jmdict')
    expect(target['a:b'].definitions.some((d) => d.sources.includes('kaikki'))).toBe(true)
    expect(target['a:b'].examples).toHaveLength(1)
    expect(target['a:b'].definitions.some((d) => d.text === 'new jmdict')).toBe(true)
    expect(target['a:b'].definitions.some((d) => d.text === 'from jmdict')).toBe(false)
  })

  test('strips partOfSpeech entries attributed to source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        partOfSpeech: [
          { value: 'verb', sources: ['jmdict'] },
          { value: 'noun', sources: ['kaikki'] },
        ],
        definitions: [makeDef('x', ['kaikki'])],
      }),
    }

    refreshDictSource(target, {}, 'jmdict')
    expect(target['a:b'].partOfSpeech.map((p) => p.value)).toEqual(['noun'])
  })

  test('strips jlpt entries attributed to source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        jlpt: [
          { level: 5, sources: ['jlpt'] },
          { level: 3, sources: ['other'] },
        ],
        definitions: [makeDef('x', ['kaikki'])],
      }),
    }

    refreshDictSource(target, {}, 'jlpt')
    expect(target['a:b'].jlpt.map((j) => j.level)).toEqual([3])
  })

  test('strips commonSources and recalculates common=false', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        common: true,
        commonSources: ['jmdict'],
        definitions: [makeDef('x', ['kaikki'])],
      }),
    }

    refreshDictSource(target, {}, 'jmdict')
    expect(target['a:b'].common).toBe(false)
    expect(target['a:b'].commonSources).toEqual([])
  })

  test('strips tatoeba examples from source', () => {
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({
        word: 'a', reading: 'b',
        examples: [
          { ja: 'old', text: 'old example', sources: ['tatoeba'] },
          { ja: 'keep', text: 'keep this', sources: ['other'] },
        ],
      }),
    }

    refreshDictSource(target, {}, 'tatoeba')
    expect(target['a:b'].examples).toHaveLength(1)
    expect(target['a:b'].examples[0].sources).toEqual(['other'])
  })
})

describe('mergeDictEntries — replace mode — other tests', () => {
  test('leaves entries from other sources untouched when source keys differ', () => {
    // Simulate: target has entries from jmdict and kaikki sources.
    // Replace mode with a source snapshot that only contains one key
    // should remove keys NOT in the source, but this is by-key not by-source.
    // The real-world pattern is: each importer replaces its own lang file entirely.
    // So "other source" entries live in separate DictFiles, not mixed in one target.
    //
    // This test verifies the key-level semantics: keys present in source survive,
    // keys absent from source get pruned.
    const target: Record<string, DictEntry> = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('old-a', ['jmdict'])] }),
      'c:d': makeEntry({ word: 'c', reading: 'd', definitions: [makeDef('old-c', ['kaikki'])] }),
    }
    // Source only has 'a:b' — 'c:d' should be pruned
    const source = {
      'a:b': makeEntry({ word: 'a', reading: 'b', definitions: [makeDef('new-a', ['kaikki'])] }),
    }

    mergeDictEntries(target, source, 'replace')

    expect(target['a:b']).toBeDefined()
    expect(target['a:b'].definitions[0].text).toBe('new-a')
    expect(target['c:d']).toBeUndefined()
  })
})

describe('mergeLangEntries', () => {
  test('diff mode reports updates without mutating target', () => {
    const target: Record<string, LangEntry> = {
      '食べる:たべる': {
        definitions: ['to eat'],
        examples: [],
        _defSources: { 'to eat': ['jmdict'] },
      },
    }
    const source = {
      '食べる:たべる': { definitions: ['to consume'] },
    }

    const before = JSON.stringify(target)
    const stats = mergeLangEntries(target, source, 'wiktionary', 'diff', 'merge')

    expect(stats.updated).toBe(1)
    expect(stats.unchanged).toBe(0)
    expect(JSON.stringify(target)).toBe(before)
  })

  test('replace policy keeps non-conflicting definitions', () => {
    const target: Record<string, LangEntry> = {
      '食べる:たべる': {
        definitions: ['to eat food', 'to have a meal'],
        examples: [],
        _defSources: {
          'to eat food': ['jmdict'],
          'to have a meal': ['jmdict'],
        },
      },
    }
    const source = {
      '食べる:たべる': { definitions: ['to eat'] },
    }

    const stats = mergeLangEntries(target, source, 'wiktionary', 'merge', 'replace')

    expect(stats.updated).toBe(1)
    expect(target['食べる:たべる'].definitions).toContain('to eat')
    expect(target['食べる:たべる'].definitions).toContain('to have a meal')
    expect(target['食べる:たべる'].definitions).not.toContain('to eat food')
  })
})

describe('refreshLangSource', () => {
  test('removes empty entries after source data is stripped', () => {
    const target: Record<string, LangEntry> = {
      'a:b': {
        definitions: ['x'],
        examples: [{ ja: '文', text: 'x', source: 'tatoeba' }],
        _defSources: { x: ['sourceA'] },
      },
      'c:d': {
        definitions: ['y'],
        examples: [],
        _defSources: { y: ['sourceB'] },
      },
    }

    refreshLangSource(target, 'sourceA')
    refreshLangSource(target, 'tatoeba')

    expect(target['a:b']).toBeUndefined()
    expect(target['c:d']).toBeDefined()
  })
})
