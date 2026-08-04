# Example generation and review prompts

Draft prompts for the enrichment path (ADR-0002, ADR-0003). Not yet wired in. When
implemented they follow the existing pattern in `scripts/ai-common.ts`: built inline by a
`promptFor(seed)` function, JSON-only output, parsed by a dedicated parser that fails loudly
on anything unexpected.

The gloss prompt in `ai-common.ts` says "Do not add examples." That stays true — glosses and
examples are produced by separate prompts and stored separately.

Target model tier is fast and cheap (Flash class, low reasoning effort), so both prompts carry
worked examples rather than relying on the model's own judgment.

## Generator

```
Write one Japanese example sentence that shows a specific meaning of a specific word,
for a dictionary used by Japanese learners.

INPUT
  word            the dictionary form
  reading         its kana reading
  partOfSpeech    JMdict part-of-speech tags
  targetSense     the English glosses of the ONE meaning to illustrate
  otherSenses     glosses of the word's other meanings, for contrast only
  tags            JMdict sense tags; "uk" means the word is normally written in kana
  languages       which translations to return

The glosses in targetSense define the meaning. They are authoritative.
otherSenses exist only so you can avoid illustrating the wrong meaning.

A correct sentence:
- contains the word, written as tags require ("uk" -> write it in kana)
- uses it in targetSense, in a way that would be wrong for any sense in otherSenses
- is natural, modern, everyday Japanese
- is 10-30 characters, exactly one sentence
- uses no vocabulary more advanced than the word itself
- makes sense alone, with no surrounding context
- invents no real people, places, brands, or events

Translations must describe the sentence you wrote, not the gloss.
Traditional Chinese must use Taiwanese vocabulary: 軟體 not 軟件, 資訊 not 信息,
影片 not 視頻, 螢幕 not 屏幕.

ABSTAIN when a natural modern sentence cannot show this meaning — archaic or
obsolete senses, narrow technical senses, or words that do not stand alone.
Abstaining is a correct answer. A forced sentence is worse than none.

OUTPUT
Return only JSON, one of these two shapes:

{"sentence": "...", "translations": {"en": "...", "zh-tw": "..."}}
{"abstain": true, "reason": "archaic" | "too_technical" | "not_standalone" | "unclear_sense"}

EXAMPLES

word 引く / ひく, targetSense ["to quote","to cite"],
otherSenses ["to pull","to tug","to draw (a line)"]
{"sentence":"先生は例を引いて説明した。",
 "translations":{"en":"The teacher explained by citing an example.",
                 "zh-tw":"老師舉例說明。"}}

word 沢山 / たくさん, tags ["uk"], targetSense ["a lot","many"]
{"sentence":"公園には子どもがたくさんいた。",
 "translations":{"en":"There were a lot of children in the park.",
                 "zh-tw":"公園裡有很多小孩。"}}

word 汝 / なんじ, targetSense ["thou","you"], tags ["arch"]
{"abstain":true,"reason":"archaic"}
```

## Reviewer

```
Decide whether a generated Japanese example sentence may enter a learner's dictionary.
You judge. You never rewrite, and you never suggest wording.

Accept ONLY if every one of these is true:
- the sentence uses the word in targetSense, and would be wrong for any sense in otherSenses
- a native speaker would write it this way today
- a learner at this word's level can read it
- each translation describes this sentence accurately
- Traditional Chinese uses Taiwanese vocabulary, not PRC vocabulary in Traditional characters
- it names no real person, place, brand, or event, and asserts nothing about the world

If any one fails, reject. When you are unsure whether the sense is right, reject.

Return only JSON:
{"decision":"accept"}
{"decision":"reject","reason":"wrong_sense" | "unnatural" | "too_complex"
                            | "translation_mismatch" | "zh_tw_style" | "unsafe_content"}
```

## Why these are shaped this way

**Abstention is the load-bearing line in the generator.** Without it the model invents a
sentence for every archaic sense and every proper noun. An empty example slot is already
handled by the card; a confident wrong sentence is not.

**The reviewer is deliberately biased toward rejecting** — "accept only if every one is true",
plus "when unsure, reject". Model judges drift toward approval, so the prompt pushes the other
way. Expect over-rejection at first; loosen only once the calibration numbers exist.

**Both prompts restate rules the deterministic filter also enforces.** That is intentional. The
filter guarantees them; the prompt avoids spending a generation that would fail them.

**Neither prompt mentions a JLPT number.** "No vocabulary more advanced than the word itself" is
something a model can actually check. "Write an N3 sentence" invites fake precision.

## Testing

Three tiers, two of which already have a pattern in this repo.

**Filter and parser tests** — extend `tests/ai-glosses.test.ts`. No model calls, runs in CI.
Cover word absent, wrong orthography under `uk`, over length, empty translation, malformed
JSON, unknown reason codes, and output that is neither valid shape. Include these PRC-term
regression cases, which a naive substring matcher gets wrong: 聚集成群 must not trip 集成,
假離線程式 must not trip 線程, 和平進程 must pass.

**Generation eval** — follow `eval-learning.ts` in yori-news, whose header already states the
approach: a small fixed fixture set scored on local contracts that stay stable when prompts or
models change. Assert properties, not exact strings, over several runs. Corpus slices: easy
single-sense words, polysemous words with a tempting wrong sense, `uk` words, archaic and
proper nouns that should abstain, and Traditional Chinese trap words. The same harness is the
model bake-off — swap the model, rerun, compare.

**Reviewer calibration** — see ADR-0003.
