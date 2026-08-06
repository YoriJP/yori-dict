# Independent English dictionary

English is a separate Yori Dict data product, not an English mode of the Japanese
dictionary. It has its own source lock, schema version, release version, validation,
artifacts, and release cadence.

## Build and lookup

The pinned source archives are committed under `sources/english/raw/`. Build a release
without downloading or calling a model:

```sh
bun run english:build -- --version 2026.08.1
```

This verifies both SHA-256 checksums and writes independently named SQLite, JSONL,
manifest, and Yomitan v3 files under `releases/english/`. Repeating a build with the same
version and inputs produces byte-identical data artifacts. `openEnglishDictionary` reads
the SQLite artifact directly; normal lookup is case-normalized and never calls a model.

The canonical English schema keeps pronunciations and sense-level part of speech,
register, region, domain, dated status, usage, examples, evidence IDs, and provenance
structured. Reconciliation merges evidence only when definition and all those sense
distinctions match. Source records and their original license metadata remain in SQLite.

The Yomitan adapter is format v3 and contains `index.json` plus `term_bank_1.json`. Its
source artifact remains the canonical JSONL or SQLite release; adapter constraints do not
flatten the canonical schema.

## On-demand enrichment

`createEnglishOnDemandDictionary` implements the same `DictionaryResolver.resolve`
contract as Japanese with `targetDictionary: "en"`. The persistent English repository
reads released entries and indexed source records, and keeps accepted entries, examples,
attempts, and terminal outcomes in a separate staging SQLite database.

The English path rejects obvious names, wrong-script text, fragments, markup, URLs, and
numbers before eligibility. Genuine words, compounds, phrasal verbs, idioms,
abbreviations, and established multiword expressions stay eligible. Authoring uses pinned
GPT-5.6 Luna; reject-only entry and example review uses pinned Gemini 3 Flash Preview.
Both use OpenRouter, minimal reasoning, and Flex first. On-demand transient failures may
fall back to Standard once; bulk calls retry Flex at most three times. Review is fail
closed, concurrent work is bounded, and identical requests share one in-flight run.

## Paid reviewer calibration

The credential-free suite tests production behavior with scripted model responses. The
live reviewer calibration is deliberately separate:

```sh
bun run english:eval -- --run
```

Luna is the selected entry author and Gemini is the reject-only reviewer. The paid command
calibrates that reviewer against valid entries and seeded omissions, invented senses,
wrong pronunciations, merged senses, circular
definitions, unsupported labels, and misleading examples. False acceptance and false
rejection are reported separately; any false acceptance blocks release. Live results are
written under ignored `data/english-evaluation/` and require `OPENROUTER_API_KEY`.
