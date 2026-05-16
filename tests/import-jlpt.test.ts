import { describe, expect, test } from 'bun:test'
import { enrichCoreWithJlpt } from '../scripts/import/jlpt'

describe('enrichCoreWithJlpt', () => {
  test('keeps the highest existing JLPT level during merge imports', () => {
    const coreEntries: Record<string, { jlpt: number | null }> = {
      '食べる:たべる': { jlpt: 5 },
      '走る:はしる': { jlpt: null },
    }

    const stats = enrichCoreWithJlpt(
      coreEntries,
      new Map([
        ['食べる:たべる', 3],
        ['走る:はしる', 4],
      ]),
      'merge'
    )

    expect(stats).toEqual({
      matched: 2,
      alreadyHad: 1,
      updated: 1,
      notFound: 0,
    })
    expect(coreEntries['食べる:たべる'].jlpt).toBe(5)
    expect(coreEntries['走る:はしる'].jlpt).toBe(4)
  })
})
