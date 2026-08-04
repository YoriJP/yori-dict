# Example generation evaluation

## Current finding

There is no live quality baseline yet. On 2026-08-04, this worktree had none of
`GEMINI_API_KEY`, `GEMINI_ZH_TW_API_KEY`, or `ANTHROPIC_API_KEY`, so no provider calls were made and no model-quality
rates are claimed. The harness was verified with deterministic model doubles, including a
malformed reviewer that fails every attempted decision. Those checks prove scoring behavior,
not Japanese quality.

The selected production generator remains the pinned triple
`(gemini-2.5-flash, low, google)`. This is a provisional operational choice, not an empirical
winner: it is already the shipped configuration, it disables fallback routing, and there is no
live evidence in this repository that justifies changing it. The first live run compares it
against `(gemini-2.5-pro, low, google)`. Keep the production triple unless that immutable run
shows a clear property-level improvement without worse abstention or reviewer outcomes.

The reviewer remains `(claude-haiku-4-5-20251001, none, anthropic)`. Do not use its decisions as
a quality signal until calibration shows both its false-accept rate and exact reason-label rate.
False accepts are the release risk; false rejects only leave an example slot empty.

Traditional Chinese translation uses the independently pinned
`(gemini-2.5-flash-lite, none, google)` triple for every generator candidate. The evaluation
records its raw response and derives zh-CN from the checked zh-TW text through OpenCC, matching
the production pipeline.

## What is measured

The fixed generation corpus covers:

- an easy single-sense entry;
- a polysemous entry where a neighboring sense is tempting;
- an entry usually written in kana;
- archaic and proper-noun entries that should abstain;
- a Traditional Chinese terminology trap.

Each candidate triple runs every case three times. A should-abstain case passes only when the
generator abstains. Other cases must parse through the production parser, pass the production
deterministic filter, and receive an explicit acceptance from the production reviewer. Exact
sentences are never asserted.

Reviewer calibration starts from six accepted examples. Each negative changes one property:
wrong sense, unnatural Japanese, excessive complexity, mismatched translation, PRC vocabulary,
or unsafe content. These map one-to-one to every production reviewer reason code. Each accepted
base is also reviewed, so false rejects have a visible denominator. A missing or malformed
decision is charged conservatively as a false accept for a defective case or a false reject for
an accepted case. A rejection with the wrong reason is a failed exact label, not a healthy pass.

## Running and reading a baseline

Run the evaluation manually with an unused run id:

```sh
GEMINI_API_KEY=... GEMINI_ZH_TW_API_KEY=... ANTHROPIC_API_KEY=... \
  bun run examples:eval -- --run-id 2026-08-04-baseline
```

The command is bounded to the two configs in `fixtures/example-evaluation-configs.json`, the six
fixed corpus cases, three repeats, and the twelve reviewer calibration decisions. To change a
candidate, edit and review the pinned config fixture first; floating `latest` model aliases are
rejected. A run records the exact triples, fixture SHA-256 hashes, git commit, all attempted
outcomes, and raw responses under `data/example-evaluation/<run-id>/result.json`.

Result directories are ignored by Git because model output is a run artifact, not source. Copy a
result elsewhere before cleaning local data. The runner creates each directory once and refuses
to overwrite it. It is deliberately absent from package release checks and CI.

Choose a generator from a live run only after checking all of these:

1. Every configured corpus attempt has an outcome; `attempted` equals corpus size times repeats.
2. The should-abstain slice is evaluated on abstention, not sentence production.
3. Failures are inspected by property and slice, especially polysemy and zh-TW.
4. Reviewer false accepts, false rejects, and exact-label denominators are all non-zero and visible.
5. Malformed or missing responses appear as failures rather than disappearing from totals.

Do not collapse the two reviewer rates into one accuracy number. A low false-accept rate is the
primary gate; use false rejects to decide whether the intentionally strict prompt can later be
loosened.
