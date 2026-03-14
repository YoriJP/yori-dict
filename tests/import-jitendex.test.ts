import { describe, expect, test } from 'bun:test'
import { resolveJitendexKey } from '../scripts/import/jitendex'
import { buildExampleOnlySourceEntry, resolveExampleImportKey } from '../scripts/import/jmdict-examples'

describe('resolveJitendexKey', () => {
  test('prefers exact word+reading key', () => {
    const key = resolveJitendexKey('文化', 'ぶんか', {
      '文化:ぶんか': { definitions: ['culture'] },
    })
    expect(key).toBe('文化:ぶんか')
  })

  test('falls back to unique word match', () => {
    const key = resolveJitendexKey('文化', 'ぶんか', {
      '文化:ぶん': { definitions: ['culture'] },
    })
    expect(key).toBe('文化:ぶん')
  })
})

describe('resolveExampleImportKey', () => {
  test('uses exact key when present', () => {
    const key = resolveExampleImportKey('学校', 'がっこう', {
      '学校:がっこう': { definitions: ['school'] },
    })
    expect(key).toBe('学校:がっこう')
  })
})

describe('buildExampleOnlySourceEntry', () => {
  test('emits examples without adding definitions', () => {
    const entry = buildExampleOnlySourceEntry([
      {
        type: 'structured-content',
        content: [
          { tag: 'span', lang: 'ja', content: '学校へ行く。' },
          { tag: 'span', lang: 'en', content: 'I go to school.' },
        ],
      },
    ], '学校', 'がっこう', 3)

    expect(entry).not.toBeNull()
    expect(entry!.definitions).toEqual([])
    expect(entry!.examples).toEqual([
      { ja: '学校へ行く。', text: 'I go to school.', source: 'jmdict-examples' },
    ])
  })
})
