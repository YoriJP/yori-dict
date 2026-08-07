# Examples attach to senses, and consumers show every sense

A learner clicking a word needs to know which meaning applies, and the obvious fix is to disambiguate by context — feed the sentence and the candidate senses to a model and pick one. We measured the actual distribution first: of the 8,741 words learners click across the yori-news archive, 62% have exactly one sense, p90 is four, and only 2.7% exceed six. Disambiguation would buy little, and it would make examples dangerous — an example attached to a confidently wrong sense looks authoritative in a way a slightly wrong gloss does not.

So examples attach to a sense, never to an entry, and consumers render every sense rather than choosing one. The card never claims a single meaning, so a per-sense example cannot mislead.

## Consequences

The API must return all senses that have glosses in the requested language, and must not collapse them. Consumers that show only the first sense (as yori-news did, via `senses[0]`) will show a plausible but arbitrary meaning; that is a consumer bug, not an API affordance.
