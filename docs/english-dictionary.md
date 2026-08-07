# Independent English dictionary

English is a separate Yori Dict data product, not an English mode of the Japanese
dictionary. It has its own source lock, schema version, release version, validation,
artifacts, and release cadence.

## Build and lookup

The pinned source archives are committed under `sources/english/raw/`. Build a source import
artifact without downloading or calling a model:

```sh
bun run english:build -- --version 2026.08.1
```

This verifies both SHA-256 checksums. Import it with `bun run db:import -- --english <sqlite>`.
Publish the complete canonical dictionary, including accepted generated entries and examples,
with `bun run english:release -- --version 2026.08.1`. Repeating a release with the same
version and canonical data produces byte-identical data artifacts. `openEnglishDictionary`
reads the SQLite artifact directly; normal lookup is case-normalized and never calls a model.

The published English schema keeps pronunciations and sense-level part of speech,
register, region, domain, dated status, usage, examples, evidence IDs, and provenance
structured. Reconciliation merges evidence only when definition and all those sense
distinctions match. Source records and their original license metadata remain in SQLite.

The Yomitan adapter is format v3 and contains `index.json` plus `term_bank_1.json`. Its
source artifact remains the canonical JSONL or SQLite release; adapter constraints do not
flatten the canonical schema.

## On-demand enrichment

`createEnglishOnDemandDictionary` is the internal English adapter behind the shared
`OnDemandDictionary.resolve` interface. English tables live in the single
production SQLite database while remaining logically independent from Japanese. Source
imports, accepted entries, examples, attempts, and terminal outcomes persist across
application deployments; published English artifacts remain independently versioned.

The English path rejects obvious names, wrong-script text, fragments, markup, URLs, and
numbers before eligibility. Genuine words, compounds, phrasal verbs, idioms,
abbreviations, and established multiword expressions stay eligible. Production author and
reviewer models are selected explicitly with `YORI_ENGLISH_AUTHOR_MODEL` and
`YORI_ENGLISH_REVIEW_MODEL` only after comparative evaluation. Both use OpenRouter,
minimal reasoning, and Flex first. On-demand transient failures may
fall back to Standard once; bulk calls retry Flex at most three times. Review is fail
closed, model concurrency is bounded globally across both dictionaries, and identical
requests share one in-flight run.

## Paid reviewer calibration

The credential-free suite tests production behavior with scripted model responses. The
live reviewer calibration is deliberately separate:

```sh
bun run english:eval -- --run \
  --author-model <candidate-a> --author-model <candidate-b> \
  --reviewer-model <candidate-c> --reviewer-model <candidate-d>
```

The paid command compares at least two authors and two reviewers. Reviewers receive opaque
candidate ids and no author identity. It exercises hard polysemy and grammatical contrast,
then calibrates every reviewer against valid entries and seeded omissions, invented senses,
wrong pronunciations, merged senses, circular definitions, unsupported labels, and
misleading examples. False acceptance and false rejection are reported separately; any
false acceptance blocks selection. Live results are written under ignored
`data/english-evaluation/` and require `OPENROUTER_API_KEY`.
