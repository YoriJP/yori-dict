import { describe, expect, test } from 'bun:test'
import { resolveCoreMergeMode } from '../scripts/import/jmdict'

describe('resolveCoreMergeMode', () => {
  test('keeps refresh mode merge-only for shared core.json', () => {
    expect(resolveCoreMergeMode('refresh')).toBe('merge')
  })

  test('preserves non-refresh import modes', () => {
    expect(resolveCoreMergeMode('merge')).toBe('merge')
    expect(resolveCoreMergeMode('diff')).toBe('diff')
    expect(resolveCoreMergeMode('replace')).toBe('replace')
  })
})
