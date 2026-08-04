# Yori Dict

Yori Dict is an open Japanese dictionary, served as an API and published as a SQLite release. The domain distinguishes what JMdict supplies from what Yori adds, and what a human wrote from what a model wrote.

## Entries and Senses

**Entry**:
A single dictionary word, identified across releases by its JMdict source id.
_Avoid_: Word, term, headword

**Headword**:
One written form of an entry, either kanji or kana, carrying JMdict's common flag.
_Avoid_: Form, spelling, surface

**Sense**:
One meaning of an entry, with its own part of speech and annotations.
_Avoid_: Definition, meaning

**Gloss**:
A sense rendered into one language.
_Avoid_: Definition, translation, meaning

**Lookup Term**:
An indexed string that resolves a query to entries, matched by kanji or by reading.
_Avoid_: Key, query, index

**Deinflection**:
Word-level reduction of an inflected form back to a dictionary form. It is lookup help, not sentence parsing.
_Avoid_: Parsing, tokenization, lemmatization

**Inflection Path**:
The ordered steps deinflection took to reach a dictionary form, returned so a learner can see why 食べました resolves to 食べる.
_Avoid_: Deinflection reason, debug output

**Generated Conjugation**:
Inflected forms derived from an entry's part-of-speech tags when the entry is read. Never stored.
_Avoid_: Conjugation table, stored form

## Enrichment

**Enrich-on-Lookup**:
Filling a gap at the moment a lookup reveals it, so the dictionary grows from real use rather than from a scope decided in advance.
_Avoid_: Batch enrichment, backfill, demand list

**Enrichment Overlay**:
The small writable store holding enrichment produced since the last data release. Staging only: the committed source files remain the durable record, and losing the overlay costs at most the unexported window.
_Avoid_: Cache, database, source of truth

**Sense Example**:
A sentence illustrating one specific sense, attached to that sense rather than to the entry.
_Avoid_: Entry example, usage note

**Sourced Example**:
A sense example written by a human and imported from an outside corpus.
_Avoid_: Generated example

**Generated Example**:
A sense example written by a model, admitted only after the deterministic filter and the reviewer both accept it.
_Avoid_: Sourced example, AI gloss

**Example Translation**:
A sense example rendered into a gloss language.
_Avoid_: Gloss, second example

**Estimated Level**:
A JLPT band taken from an unofficial published list. No official JLPT vocabulary list has existed since 2010, so the band is an estimate and is presented as one.
_Avoid_: JLPT level, official level, difficulty

**Data Release**:
A versioned, published SQLite artifact. The service loads a pinned release rather than building its own, so the API serves exactly what the public downloads.
_Avoid_: Build output, database, deploy

## Review

**Deterministic Filter**:
Pure-code validation that runs before any model sees a candidate: target word present, length within bounds, expected script, translation non-empty.
_Avoid_: Model review, linting

**Reviewer**:
A model that accepts or rejects a candidate with a reason code, and never rewrites it.
_Avoid_: Editor, fixer, corrector

**Reason Code**:
The fixed vocabulary a reviewer rejects with — wrong-sense, unnatural, translation-mismatch, too-complex, off-topic — chosen so rejections can be counted.
_Avoid_: Review comment, free-text feedback

**Review Status**:
Whether a gloss or example came from the source dictionary untouched, or passed Yori's own review.
_Avoid_: Verified, approved, quality

**Taiwan Terminology**:
The requirement that Traditional Chinese output uses Taiwanese vocabulary, not PRC vocabulary rendered in Traditional characters. 軟體 not 軟件; 資訊 not 信息.
_Avoid_: Traditional Chinese, zh-TW correctness, character conversion

**Generation Provenance**:
The full record of what produced a candidate: model snapshot, reasoning effort, and serving provider. A floating model alias makes provenance meaningless, so none is used.
_Avoid_: Model name, model version
