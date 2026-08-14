# Yori Dict

Yori Dict publishes open dictionary data for other tools and people. Its Japanese and English dictionaries are independent data products with independent sources, schemas, and releases. The hosted backend consumes the same data for Yori products, but is not the primary product.

## Dictionaries and Sources

**Dictionary**:
One independently released lexical dataset, such as the Japanese dictionary or the English dictionary.
_Avoid_: Track, locale, translation

**Source Dataset**:
An outside dictionary or corpus whose license permits Yori Dict to import and redistribute selected material.
_Avoid_: Provider, model source

**Licence Gate**:
A source is admitted only if its licence permits redistribution under CC BY-SA 4.0. Licence is a gate, not a trade-off: fitness, quality, and coverage are judged only after it passes, and no attribution string substitutes for a missing grant. A coverage gap is recoverable through Enrich-on-Lookup; an unlicensed source is not. A dataset that bundles separately-owned components is admitted component by component, never wholesale.
_Avoid_: License check, compliance review

**Source Evidence**:
The combined senses, labels, pronunciations, and examples supplied to generation from licensed source datasets. It establishes minimum coverage but is not text to translate mechanically.
_Avoid_: Prompt context, source gloss

**Canonical Entry**:
Yori Dict's clean representation of one lexical item, authored from source evidence and, when necessary, model knowledge. Imported source records remain intact underneath it.
_Avoid_: Generated translation, merged source

**Generated Sense**:
An established sense added from model knowledge because the available source evidence missed it. It carries generation and review provenance and never masquerades as imported source material.
_Avoid_: Hallucinated sense, translated sense

## Entries and Senses

**Entry**:
A single lexical item inside one dictionary, with a stable Yori Dict id. Source identifiers remain attached as provenance rather than defining the entry's identity.
_Avoid_: Word, term, headword

**Headword**:
One written form of an entry, either kanji or kana, carrying JMdict's common flag.
_Avoid_: Form, spelling, surface

**Sense**:
One meaning of an entry in one explanation language, with its own part of speech and annotations. Each explanation language owns its senses: their identifiers, order, and divisions never have to line up across languages. This is the only word for the concept: the API field is `senses`, the release JSONL key is `senses`, and the canonical tables are `ja_senses` and `en_senses`.
_Avoid_: Definition, meaning

**Explanation Language**:
The language a sense explains an entry in, stored on the sense rather than encoded into a table name. A lookup names one, and gets that language's own senses or nothing.
_Avoid_: Target language, gloss language, language pair

**Explanation Group**:
The complete meaning coverage and ordered senses through which one explanation language explains one entry. Groups for different explanation languages are independent and need not divide meaning in the same way; completeness does not promise that every sense already has an example.
_Avoid_: Translation set, language version, parallel senses

**Gloss**:
A sense rendered into one language. A sense may hold complementary glosses, but distinct meanings remain separate senses; glosses and senses are not interchangeable.
_Avoid_: Definition, translation, sense

**Circular Gloss**:
A gloss that repeats the headword, reading, or empty boilerplate instead of explaining the sense. Obvious forms are invalid directly; semantic circularity is a review judgement.
_Avoid_: Short gloss, synonym

**Lookup Term**:
An indexed string that resolves a query to entries, matched by kanji or by reading.
_Avoid_: Key, query, index

**Deinflection**:
Word-level reduction of an inflected form back to a dictionary form. It is lookup help, not sentence parsing.
_Avoid_: Parsing, tokenization, lemmatization

**Inflection Stripping**:
Deinflection's English counterpart: regular suffix substitutions that generate candidate lemmas, validated against the stored Lookup Terms. It is deliberately small because the lexicon rejects the wrong guesses, and it carries no irregular exception list. One module serves both callers — lookup resolution and the authoring guard — so they cannot disagree about what an inflected surface is. Import is not a caller: a source that declares which of its own senses are word forms is telling us, and stripping its headwords on top of that deletes lexemes the primary inventory merely lacks. Unlike Deinflection it is silent: English has no Inflection Path.
_Avoid_: Lemmatization, stemming, English deinflection

**Inflection Path**:
The ordered steps deinflection took to reach a dictionary form, returned so a learner can see why 食べました resolves to 食べる.
_Avoid_: Deinflection reason, debug output

**Generated Conjugation**:
Inflected forms derived from an entry's part-of-speech tags when the entry is read. Never stored.
_Avoid_: Conjugation table, stored form

## Enrichment

**Enrich-on-Lookup**:
Filling a missing entry, sense, gloss, or example when an authorized lookup reveals the gap, so real use determines growth.
_Avoid_: Batch enrichment, backfill, demand list

**Entry Candidate**:
The surface text and sentence context sent by a consumer such as Yori News when lookup misses. It is untrusted and may be an inflection, another language, a fragment, or extraction noise.
_Avoid_: Entry, headword

**Canonical Headword Decision**:
The eligibility result produced after lookup and source discovery miss: one canonical headword, or `SKIP`. It never contains an explanation.
_Avoid_: Classification, rejection report

**Source-Grounded Authoring**:
Creating a canonical entry from source evidence plus lexical knowledge. The author may clarify, split, or add established senses, but must preserve every supported sense and its provenance.
_Avoid_: Direct translation, free generation

**Production Database**:
The persistent canonical SQLite store used by lookup and authenticated enrichment. It holds both dictionaries, accepted generated content, source provenance, and private attempt records; published releases are immutable snapshots of it.
_Avoid_: Overlay, release artifact, cache

**Sense Example**:
A sentence illustrating one specific sense, attached to that sense rather than to the entry.
_Avoid_: Entry example, usage note

**Monolingual Sense Example**:
A Sense Example written in the same language as both its entry and its Explanation Group. It stands on its own rather than carrying a duplicate rendering in that same language.
_Avoid_: Self-translation, untranslated example

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
A versioned, immutable snapshot exported from one dictionary's canonical production tables. Japanese and English releases remain independently consumable even though runtime uses one physical database.
_Avoid_: Build output, database, deploy

## Review

**Deterministic Filter**:
Pure-code validation that runs before any model sees a candidate: the target word present in any inflected form, length within bounds, expected script, translation non-empty.
_Avoid_: Model review, linting, literal string match

**Reviewer**:
A separately trained model family that returns exactly `ACCEPT` or `REJECT` and never rewrites a candidate. Any other response is malformed and fails closed.
_Avoid_: Editor, fixer, corrector

**Review Status**:
Whether a gloss or example came from the source dictionary untouched, or passed Yori's own review.
_Avoid_: Verified, approved, quality

**Taiwan Terminology**:
The requirement that Traditional Chinese output uses Taiwanese vocabulary, not PRC vocabulary rendered in Traditional characters. 軟體 not 軟件; 資訊 not 信息.
_Avoid_: Traditional Chinese, zh-TW correctness, character conversion

**Generation Provenance**:
The full record of what produced a candidate: model snapshot, reasoning effort, and serving provider. A floating model alias makes provenance meaningless, so none is used.
_Avoid_: Model name, model version

**Attempt Record**:
The observable record of one provider call: role, prompt version, model snapshot, reasoning effort, provider, requested and effective service tier, request id, duration, token use, and classified outcome.
_Avoid_: Debug log, trace dump
