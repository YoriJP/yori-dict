# English content follows an explicit source policy

English content used to be reconciled generically: every source record was sorted by source name and source entry id, grouped by headword, and meanings from different sources were merged whenever a normalized definition string and its labels happened to match. That ordering was an accident of the identifiers rather than any lexicographer's judgement, and merging by wording is exactly the comparison no automated step should be making across two independently edited dictionaries.

English now stores canonical content in concise `en_*` tables on the same design as Japanese: an entry owns identity, written form and pronunciations, and `en_senses` carries the explanation language as data. Gloss and example rows have no language of their own. English explanations of English headwords are the group whose language is `en`; another explanation language is more rows, not another table or a language-pair schema.

The source policy is explicit and deterministic. Open English WordNet is the primary meaning inventory because it has the broader coverage, and meanings are read from its `entries-*.json` lexical entries so that each entry's part-of-speech blocks and their `sense` arrays keep the archive's own editorial order. That recovered order is the canonical meaning order everywhere downstream. Simple English Wiktionary is fallback and reference: it supplies the whole entry for a headword Open English WordNet does not carry, and otherwise only fills a pronunciation gap matched on the exact headword. A secondary canonical meaning is admitted only through a mapping row naming an exact evidence identifier. No model compares definitions, and there is no general semantic merger.

Canonical rows keep selected text with concise provenance — source name and version, a stable evidence identifier, review status, and a generation reference. Complete raw source records stay reproducible rebuild inputs and are no longer stored as release rows.

## Consequences

Rebuilding twice from the same pinned archives produces byte-identical canonical SQLite, JSONL and Yomitan artifacts, and the meaning order a reader sees is Open English WordNet's, not an identifier's.

Simple English Wiktionary can no longer quietly inject a competing meaning into a headword the primary source already explains. Adding one is a deliberate, reviewable mapping row.

Enrichment authors one entry-language group per request and one reviewer accepts or rejects it, exactly as Japanese does. Owner-authorized lookup fills only a missing entry, a missing explanation-language group, or a missing generated example; correct imported meanings are never rewritten.

A release publishes one canonical SQLite and JSONL plus one Yomitan pack per explanation language, named `yori-en-<lang>.zip`, with a manifest reporting exact per-language coverage, source versions, checksums, licenses and artifact names. Source maintenance is a deliberate full rebuild into a fresh file; a failed rebuild leaves the previous database usable, and accepted generated content is carried across.
