# Independent English dictionary

English is a separate Yori Dict data product, not an English mode of the Japanese
dictionary. It has its own source lock, schema version, release version, validation,
artifacts, and release cadence.

## Canonical schema

Canonical English content lives in concise `en_*` tables. One `en_entries` row owns
identity, written form and lookup terms; `en_pronunciations` and `en_entry_sources` hang off
it. Everything that explains the entry hangs off `en_senses`, which stores the explanation
language as data. `en_glosses` and `en_examples` have no language column of their own, so a
gloss can only ever belong to the one language its meaning declares. There are no
language-pair tables: another explanation language for the same English headword is more
`en_senses` rows, not another schema.

Meanings keep part of speech, register, region, domain, dated status and usage labels, plus
concise provenance: selected text, source name and version, a stable evidence identifier,
review status, and a generation reference for accepted generated content. Complete raw
source records stay reproducible rebuild inputs; they are never canonical release rows.

## Source policy

The policy is explicit and deterministic, and no model takes part in it.

- **Open English WordNet is primary.** It has the broader meaning inventory. Meanings are
  read from the archive's `entries-*.json` lexical entries, keeping each entry's
  part-of-speech blocks and their `sense` arrays in the archive's own order. That recovered
  editorial order is the canonical meaning order; nothing sorts by source name or synset id.
  The source's own sense key is the stable evidence identifier, and its synset supplies the
  definition, examples and domain topic.
- **Simple English Wiktionary is fallback and reference.** It supplies the whole entry for a
  headword Open English WordNet does not carry, and otherwise only fills a pronunciation gap
  matched on the exact headword.
- **Secondary canonical meanings need an exact mapping.** A `--secondary` JSONL row names one
  exact fallback evidence identifier. A row naming evidence the pinned sources no longer
  produce is dropped and counted, not guessed at. Nothing compares two differently worded
  trusted definitions.

Imported examples are kept where a source maps them exactly to a meaning; accepted generated
examples are appended after them and keep their own provenance.

## Build and publish

The pinned source archives are committed under `sources/english/raw/`. Rebuild the whole
canonical dictionary from them without downloading or calling a model:

```sh
bun run english:build -- --version 2026.08.1 --out data/yori-english.sqlite
```

This verifies both SHA-256 checksums, stages the rebuild and only then replaces the previous
file, so a failed rebuild leaves the old database usable. Accepted generated entries and
accepted generated examples on imported meanings are carried across. Graft the result onto
production with `importEnglishRelease`, then publish with:

```sh
bun run english:release -- --version 2026.08.1
```

A release is a canonical SQLite snapshot plus its gzip and checksum, JSONL with one content
group per explanation language under each entry, a coverage and source manifest, and one
Yomitan pack per explanation language (`yori-en-<lang>.zip`). Rebuilding twice from the same
pinned inputs produces byte-identical artifacts. The manifest reports exact entry, meaning,
gloss and example coverage per language, plus source versions, checksums, licenses and
artifact names.

Japanese and Taiwanese Chinese explanations for English headwords are authored from
filtered source evidence produced separately by `bun run english:evidence`. See
[English multilingual source pipeline](english-source-pipeline.md); that evidence is an
import artifact and never a release table.

English lookup uses the same v1 contract as Japanese: `dictionary=en` with an explicit
`lang`. English content is currently authored in English only, so `lang=en` is the one
supported pair; another language is a request error rather than an English answer in
disguise. The response uses the shared base entry shape — id, dictionary, lang, headword,
headwords, meanings, sources — and English keeps its pronunciations. Public lookup reads the
canonical tables and makes zero model calls; it returns `null` only for absent or rejected
content.

The Yomitan adapter is format v3 and contains `index.json` plus `term_bank_1.json`. It reads
canonical meanings in their stored order; the adapter never drives the canonical schema and
never flattens two explanation languages into one pack.

## On-demand enrichment

`createEnglishOnDemandDictionary` is the internal English adapter behind the shared
`OnDemandDictionary.resolve` interface. The `en_*` tables live in the single production
SQLite database while remaining logically independent from Japanese. Accepted entries,
examples, attempts, and terminal outcomes persist across application deployments; published
English artifacts remain independently versioned.

Enrichment is language scoped, like Japanese: `saveEntry(entry, lang, generation)` writes
exactly one entry-language group atomically. Owner-authorized lookup fills only a missing
entry, a missing explanation-language group, or a missing generated example — correct
imported meanings are never rewritten. One author request writes the complete missing group
and one separate reviewer accepts or rejects it; examples are authored and reviewed
independently, one meaning at a time, and one useful learner example per meaning is enough.
A rejected example is not saved and stays retryable on a later owner lookup; a malformed
model response is terminal so a candidate the model cannot form does not loop.

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
