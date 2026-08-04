# Example generation and review prompts

Prompts for the enrichment path (ADR-0002, ADR-0003). They follow the existing pattern in
`scripts/ai-common.ts`: built inline by a
`promptFor(seed)` function, JSON-only output, parsed by a dedicated parser that fails loudly
on anything unexpected.

The gloss prompt in `ai-common.ts` says "Do not add examples." That stays true — glosses and
examples are produced by separate prompts and stored separately.

The generation and translation models use fast Flash-class tiers. Prompts carry explicit
contracts and examples rather than relying on the models' own judgment.

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

The glosses in targetSense define the meaning. They are authoritative.
otherSenses exist only so you can avoid illustrating the wrong meaning.

A correct sentence:
- contains the word, in whatever form the sentence needs — conjugated is normal
  and expected — written in the script the tags require ("uk" -> kana)
- uses it in targetSense, in a way that would be wrong for any sense in otherSenses
- is natural, modern, everyday Japanese
- is 10-30 characters, exactly one sentence
- uses no vocabulary more advanced than the word itself
- makes sense alone, with no surrounding context
- invents no real people, places, brands, or events

The English translation must describe the sentence you wrote, not the gloss.

ABSTAIN when a natural modern sentence cannot show this meaning — archaic or
obsolete senses, narrow technical senses, or words that do not stand alone.
Abstaining is a correct answer. A forced sentence is worse than none.

OUTPUT
Return only JSON, one of these two shapes:

{"sentence": "...", "english": "..."}
{"abstain": true, "reason": "archaic" | "too_technical" | "not_standalone" | "unclear_sense"}

EXAMPLES

word 引く / ひく, targetSense ["to quote","to cite"],
otherSenses ["to pull","to tug","to draw (a line)"]
{"sentence":"先生は例を引いて説明した。",
 "english":"The teacher explained by citing an example."}

word 沢山 / たくさん, tags ["uk"], targetSense ["a lot","many"]
{"sentence":"公園には子どもがたくさんいた。",
 "english":"There were a lot of children in the park."}

word 汝 / なんじ, targetSense ["thou","you"], tags ["arch"]
{"abstain":true,"reason":"archaic"}
```

## Traditional Chinese translator

Japanese generation and Traditional Chinese translation are separate, independently pinned
model calls. The translator receives only an accepted-shape Japanese candidate and returns:

```
Translate this Japanese example sentence into Traditional Chinese used in Taiwan.
Translate the sentence, not the dictionary gloss. Use Taiwanese vocabulary: 軟體 not 軟件,
資訊 not 信息, 影片 not 視頻, 螢幕 not 屏幕.

OUTPUT
Return only JSON: {"translation":"..."}
```

The deterministic Taiwan terminology gate checks this result. Simplified Chinese is then
derived from the checked zh-TW text with the existing OpenCC `twp` to `cn` conversion; it is
never produced by another model call.

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

Each candidate carries an id. Return one JSON object per candidate, one per
line, and nothing else. Every id you were given must appear exactly once.

{"id":"<candidate id>","decision":"accept"}
{"id":"<candidate id>","decision":"reject","reason":"wrong_sense" | "unnatural"
      | "too_complex" | "translation_mismatch" | "zh_tw_style" | "unsafe_content"}
```

## Why these are shaped this way

**Abstention is the load-bearing line in the generator.** Without it the model invents a
sentence for every archaic sense and every proper noun. An empty example slot is already
handled by the card; a confident wrong sentence is not.

**The reviewer is deliberately biased toward rejecting** — "accept only if every one is true",
plus "when unsure, reject". Model judges drift toward approval, so the prompt pushes the other
way. Expect over-rejection at first; loosen only once the calibration numbers exist.

**One verdict per candidate, each carrying an id.** The bundle runner reviews many rows at a
time, so a verdict with no identifier cannot be matched to its candidate and an omitted candidate
cannot be detected — which is the silent-review failure ADR-0003 exists to prevent. The parser
rejects output that omits an id, repeats one, or names one that was not in the bundle. This
mirrors what `review-ai-glosses.ts` already does for gloss issues.

**The word-presence check is morphological, not literal.** A natural sentence conjugates: the
worked example for 引く contains 引いて, not 引く. A substring check would reject it and most
other valid verb examples. The filter resolves candidate tokens through the existing
deinflection before deciding the target word is absent.

**The prompts restate rules the deterministic filter also enforces.** That is intentional. The
filter guarantees them; the prompts avoid spending calls on candidates that would fail it.

**Neither prompt mentions a JLPT number.** "No vocabulary more advanced than the word itself" is
something a model can actually check. "Write an N3 sentence" invites fake precision.

## Testing

Three tiers, two of which already have a pattern in this repo.

**Filter and parser tests** — extend `tests/ai-glosses.test.ts`. No model calls, runs in CI.
Cover word absent after deinflection, word present only in a conjugated form (which must pass),
wrong orthography under `uk`, over length, empty translation, malformed JSON, unknown reason
codes, a verdict for an id that was not in the bundle, and a bundle where one candidate has no
verdict. Include these PRC-term
regression cases, which a naive substring matcher gets wrong: 聚集成群 must not trip 集成,
假離線程式 must not trip 線程, 和平進程 must pass.

**Generation eval** — follow `eval-learning.ts` in yori-news, whose header already states the
approach: a small fixed fixture set scored on local contracts that stay stable when prompts or
models change. Assert properties, not exact strings, over several runs. Corpus slices: easy
single-sense words, polysemous words with a tempting wrong sense, `uk` words, archaic and
proper nouns that should abstain, and Traditional Chinese trap words. The same harness is the
model bake-off — swap the model, rerun, compare.

**Reviewer calibration** — see ADR-0003.
