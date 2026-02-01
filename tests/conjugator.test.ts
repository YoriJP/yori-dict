import { describe, test, expect } from 'bun:test'
import { conjugate, detectVerbType } from '../src/conjugator'

describe('detectVerbType', () => {
  test('detects ichidan verb', () => {
    expect(detectVerbType(['ichidan verb'])).toBe('ichidan')
    expect(detectVerbType(['ichidan verb', 'transitive verb'])).toBe('ichidan')
  })

  test('detects godan verb', () => {
    expect(detectVerbType(['godan verb'])).toBe('godan')
    expect(detectVerbType(['godan verb', 'intransitive verb'])).toBe('godan')
  })

  test('detects suru verb', () => {
    expect(detectVerbType(['suru verb'])).toBe('suru')
    expect(detectVerbType(['noun', 'suru verb'])).toBe('suru')
  })

  test('detects kuru verb', () => {
    expect(detectVerbType(['kuru verb'])).toBe('kuru')
    expect(detectVerbType(['kuru verb', 'intransitive verb'])).toBe('kuru')
  })

  test('detects i-adjective', () => {
    expect(detectVerbType(['i-adjective'])).toBe('i-adjective')
    expect(detectVerbType(['adjective-i'])).toBe('i-adjective')
  })

  test('returns null for non-conjugatable types', () => {
    expect(detectVerbType(['noun'])).toBeNull()
    expect(detectVerbType(['adverb'])).toBeNull()
    expect(detectVerbType(['particle'])).toBeNull()
    expect(detectVerbType(['na-adjective'])).toBeNull()
  })
})

describe('conjugate - Ichidan verbs', () => {
  test('食べる (to eat)', () => {
    const result = conjugate('食べる', 'たべる', ['ichidan verb'])
    
    expect(result).toBeDefined()
    expect(result!.dictionary).toBe('食べる')
    expect(result!.polite).toBe('たべます')
    expect(result!.negative).toBe('たべない')
    expect(result!.past).toBe('たべた')
    expect(result!.te).toBe('たべて')
  })

  test('見る (to see)', () => {
    const result = conjugate('見る', 'みる', ['ichidan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('みます')
    expect(result!.negative).toBe('みない')
    expect(result!.past).toBe('みた')
    expect(result!.te).toBe('みて')
  })
})

describe('conjugate - Godan verbs', () => {
  test('買う (u-ending: to buy)', () => {
    const result = conjugate('買う', 'かう', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.dictionary).toBe('買う')
    expect(result!.polite).toBe('かいます')
    expect(result!.negative).toBe('かわない')
    expect(result!.past).toBe('かった')
    expect(result!.te).toBe('かって')
  })

  test('書く (ku-ending: to write)', () => {
    const result = conjugate('書く', 'かく', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('かきます')
    expect(result!.negative).toBe('かかない')
    expect(result!.past).toBe('かいた')
    expect(result!.te).toBe('かいて')
  })

  test('泳ぐ (gu-ending: to swim)', () => {
    const result = conjugate('泳ぐ', 'およぐ', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('およぎます')
    expect(result!.negative).toBe('およがない')
    expect(result!.past).toBe('およいだ')
    expect(result!.te).toBe('およいで')
  })

  test('話す (su-ending: to speak)', () => {
    const result = conjugate('話す', 'はなす', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('はなします')
    expect(result!.negative).toBe('はなさない')
    expect(result!.past).toBe('はなした')
    expect(result!.te).toBe('はなして')
  })

  test('待つ (tsu-ending: to wait)', () => {
    const result = conjugate('待つ', 'まつ', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('まちます')
    expect(result!.negative).toBe('またない')
    expect(result!.past).toBe('まった')
    expect(result!.te).toBe('まって')
  })

  test('死ぬ (nu-ending: to die)', () => {
    const result = conjugate('死ぬ', 'しぬ', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('しにます')
    expect(result!.negative).toBe('しなない')
    expect(result!.past).toBe('しんだ')
    expect(result!.te).toBe('しんで')
  })

  test('遊ぶ (bu-ending: to play)', () => {
    const result = conjugate('遊ぶ', 'あそぶ', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('あそびます')
    expect(result!.negative).toBe('あそばない')
    expect(result!.past).toBe('あそんだ')
    expect(result!.te).toBe('あそんで')
  })

  test('読む (mu-ending: to read)', () => {
    const result = conjugate('読む', 'よむ', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('よみます')
    expect(result!.negative).toBe('よまない')
    expect(result!.past).toBe('よんだ')
    expect(result!.te).toBe('よんで')
  })

  test('取る (ru-ending godan: to take)', () => {
    const result = conjugate('取る', 'とる', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('とります')
    expect(result!.negative).toBe('とらない')
    expect(result!.past).toBe('とった')
    expect(result!.te).toBe('とって')
  })
})

describe('conjugate - Special case: 行く', () => {
  test('行く uses って/った instead of いて/いた', () => {
    const result = conjugate('行く', 'いく', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.te).toBe('いって')  // NOT いいて
    expect(result!.past).toBe('いった') // NOT いいた
  })

  test('ゆく also uses って/った', () => {
    const result = conjugate('行く', 'ゆく', ['godan verb'])
    
    expect(result).toBeDefined()
    expect(result!.te).toBe('ゆって')
    expect(result!.past).toBe('ゆった')
  })
})

describe('conjugate - する verbs', () => {
  test('する (to do)', () => {
    const result = conjugate('する', 'する', ['suru verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('します')
    expect(result!.negative).toBe('しない')
    expect(result!.past).toBe('した')
    expect(result!.te).toBe('して')
  })

  test('勉強する (noun + suru compound)', () => {
    const result = conjugate('勉強する', 'べんきょうする', ['suru verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('べんきょうします')
    expect(result!.negative).toBe('べんきょうしない')
    expect(result!.past).toBe('べんきょうした')
    expect(result!.te).toBe('べんきょうして')
  })
})

describe('conjugate - 来る verb', () => {
  test('来る (to come)', () => {
    const result = conjugate('来る', 'くる', ['kuru verb'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('きます')
    expect(result!.negative).toBe('こない')
    expect(result!.past).toBe('きた')
    expect(result!.te).toBe('きて')
  })
})

describe('conjugate - i-adjectives', () => {
  test('高い (expensive/tall)', () => {
    const result = conjugate('高い', 'たかい', ['i-adjective'])
    
    expect(result).toBeDefined()
    expect(result!.dictionary).toBe('高い')
    expect(result!.polite).toBe('たかいです')
    expect(result!.negative).toBe('たかくない')
    expect(result!.past).toBe('たかかった')
    expect(result!.te).toBe('たかくて')
  })

  test('美味しい (delicious)', () => {
    const result = conjugate('美味しい', 'おいしい', ['i-adjective'])
    
    expect(result).toBeDefined()
    expect(result!.polite).toBe('おいしいです')
    expect(result!.negative).toBe('おいしくない')
    expect(result!.past).toBe('おいしかった')
    expect(result!.te).toBe('おいしくて')
  })
})

describe('conjugate - Non-conjugatable words', () => {
  test('noun returns undefined', () => {
    const result = conjugate('猫', 'ねこ', ['noun'])
    expect(result).toBeUndefined()
  })

  test('adverb returns undefined', () => {
    const result = conjugate('とても', 'とても', ['adverb'])
    expect(result).toBeUndefined()
  })

  test('na-adjective returns undefined', () => {
    const result = conjugate('静か', 'しずか', ['na-adjective'])
    expect(result).toBeUndefined()
  })
})

describe('conjugate - Kanji preservation', () => {
  test('dictionary form uses kanji when word differs from reading', () => {
    const result = conjugate('食べる', 'たべる', ['ichidan verb'])
    
    expect(result).toBeDefined()
    expect(result!.dictionary).toBe('食べる') // Kanji preserved
  })

  test('hiragana-only word uses hiragana for dictionary', () => {
    const result = conjugate('たべる', 'たべる', ['ichidan verb'])
    
    expect(result).toBeDefined()
    expect(result!.dictionary).toBe('たべる')
  })
})
