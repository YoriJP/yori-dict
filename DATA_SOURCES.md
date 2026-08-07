# Data Sources

This repository contains code and data with separate licenses.

## Code

The API server, import scripts, review scripts, release packaging script, tests,
and other source code in this repository are licensed under the MIT License.
See [LICENSE](LICENSE).

## JMdict Data

The dictionary database is built from JMdict-simplified, which is derived from
the JMdict project maintained by the Electronic Dictionary Research and
Development Group.

JMdict dictionary data is distributed under Creative Commons
Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).

Source:

- https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project
- https://www.edrdg.org/edrdg/licence.html

## Legacy Generated Glosses

Older Japanese releases include reviewed generated gloss sources committed at:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/zh-cn.jsonl
sources/ai-glosses/ko.jsonl
```

These bounded legacy rows were generated from JMdict sense data and reviewed
before they were committed under `sources/ai-glosses/`. They are
distributed under CC BY-SA 4.0 for compatibility with the JMdict-derived data
they extend. Public responses map their historical stored `ai-assisted` source
value to `generated`. New missing entries and examples go through the
authenticated on-demand resolver; the removed batch gloss pipeline is not a
current authoring path.

The committed Simplified Chinese legacy glosses were derived from the reviewed
Traditional Chinese source with OpenCC phrase conversion and validated as a
separate `zh-cn` source file. That conversion path is retained only in release
history, not as an active command.

On-demand Traditional Chinese validation also rejects a reviewed policy of PRC-specific
terms. The policy derives replacements from OpenCC's `TWPhrases` mapping and
adds the audited `初中` gap. OpenCC is deliberately not applied as a
mapping-wide rejection list: it also maps valid, context-dependent Taiwanese
words such as `進程`, and naive substring matching corrupts words such as
`聚集成群`. Ambiguous terms are rejected only in the technical contexts where
the OpenCC replacement applies. The check therefore
uses word boundaries, reviewed contexts, and phrase exceptions. The executable
policy lives in `scripts/taiwan-terminology.ts`.

## Tatoeba Example Sentences

Sourced sense examples come from Tatoeba through the `jmdict-examples-eng`
asset published by `scriptin/jmdict-simplified`. Each example remains attached
to its JMdict sense and retains its Tatoeba sentence ID.

Tatoeba sentence data is distributed under Creative Commons Attribution 2.0
France (CC BY 2.0 FR).

Sources:

- https://tatoeba.org/
- https://tatoeba.org/en/terms_of_use
- https://github.com/scriptin/jmdict-simplified

## Generated Example Sentences

Accepted generated examples are written directly to the canonical production database.
Every candidate passes deterministic sentence, word-presence, translation, and
Taiwanese-terminology checks before a separate model family may accept it. Japanese and
English release commands include those canonical examples in their next immutable snapshots.
These additions are distributed under CC BY-SA 4.0.

## Source-Grounded Generated Entries

Authenticated on-demand lookup may add a new canonical Japanese entry when
existing data and indexed licensed sources do not already provide one. The
authoring prompt receives source evidence where available, deterministic checks
require every cited source meaning to remain represented, and a separate model
family performs reject-only review. Any additional model-known sense is marked
`generated` and cannot claim a source evidence ID.

`bun run japanese:release -- --version <version>` snapshots every canonical Japanese entry
as SQLite, JSONL, and Yomitan v3 artifacts. `bun run english:release -- --version <version>`
does the same for English. Generated senses remain distinguishable through their generation
provenance; these project-authored additions are distributed under CC BY-SA 4.0.

## Independent English Dictionary

The English dictionary uses two independently reviewed, redistribution-compatible sources:

- Open English WordNet 2025 is distributed under CC BY 4.0. It supplies broad,
  structured synsets and human-authored examples. Releases must credit the Open English
  WordNet contributors and retain its version and synset identifiers.
- The Simple English Wiktionary extract dated 2026-07-06 is distributed under the
  Wiktionary terms, CC BY-SA 4.0 and GFDL 1.1 or later. It adds learner-readable
  definitions, pronunciations, usage labels, and examples. Releases must credit Simple
  English Wiktionary contributors and Wiktextract and provide the same-license terms.

These terms permit redistribution and modification with attribution; the Wiktionary
share-alike requirement determines the combined English artifact license. The accepted
source versions, URLs, archive checksums, licenses, and attribution text are committed in
`sources/english/source-lock.json`. The checksummed source archives are committed beside
that lock so an English release never changes because an upstream URL moved.

Imported records remain stored as unchanged structured JSON across the English SQLite
`source_records` and deduplicated `source_payloads` tables.
Canonical entries carry separate source evidence IDs and stable `yori:en:*` identities;
they do not adopt either source's identity. The English SQLite, JSONL, manifest, and
Yomitan v3 artifacts are distributed under CC BY-SA 4.0 and must retain both source
attributions.

Sources:

- https://github.com/globalwordnet/english-wordnet
- https://en-word.net/
- https://kaikki.org/dictionary/rawdata.html
- https://simple.wiktionary.org/wiki/Wiktionary:Copyrights
- https://github.com/tatuylonen/wiktextract

## English Multilingual Source Evidence

Japanese and Taiwanese Chinese explanations for English headwords are authored from
filtered source evidence, not published directly from it. `bun run english:evidence`
streams the full English Wiktionary Wiktextract archive and writes a bounded filtered
artifact plus a manifest under `sources/english/evidence/`. Both remain import artifacts
outside canonical release tables. `docs/english-source-pipeline.md` describes the rules.

The complete archive is never committed. It was about 2.65 GiB compressed when
researched, and the pipeline reads it from the ignored resumable cache pinned in
`sources/english/wiktionary-full-lock.json`. The manifest records the archive's URL, dump
date, compressed checksum and size, HTTP metadata when available, license, attribution,
and the filter tool version, so the evidence stays reproducible and attributable.

The full English Wiktionary extract is distributed under the Wiktionary terms, CC BY-SA
4.0 and GFDL 1.1 or later, and credits English Wiktionary contributors and Wiktextract.
Its translation records are authoring and review evidence: they describe a Japanese or
Chinese word under an English meaning, not an independently written Japanese or Chinese
dictionary entry.

Two mapped sources supply stronger evidence:

- Japanese WordNet, credited to NICT and distributed under its BSD-style license, is
  admitted only through validated Princeton WordNet/ILI mappings. Accepted rows retain
  the ILI id, PWN synset, mapping source, and mapping version. The project is old and
  warns that translated definitions and examples may contain errors.
- Taiwan government terminology, published under the Open Government Data License,
  Taiwan 1.0, is authoritative only inside its stated domains. Each row retains its
  agency, dataset, domain, version, attribution, and exact English/Chinese term pair.

`zh-tw` is assigned only where Taiwan terminology corroborates the exact term. Traditional
characters alone are not Taiwanese localization. Reverse JMdict, CC-CEDICT, and Simplified
Chinese WordNet records may support review but never become canonical through string or
reverse-gloss matching. NTU Chinese Wordnet is not imported without a separately
documented permission grant.

Sources:

- https://kaikki.org/dictionary/downloads/en/
- https://en.wiktionary.org/wiki/Wiktionary:Copyrights
- https://bond-lab.github.io/wnja/
- https://github.com/globalwordnet/cili
- https://terms.naer.edu.tw/
- https://data.gov.tw/license

## Estimated Levels

Estimated levels come from `stephenmk/yomitan-jlpt-vocab`, pinned by commit in
the download script and joined to entries only by `jmdict_seq`. That project
packages its dictionary under CC BY-SA 4.0 and attributes the underlying JLPT
lists to Jonathan Waller under CC BY. These are unofficial estimates: the JLPT
does not publish an official vocabulary list.

Sources:

- https://github.com/stephenmk/yomitan-jlpt-vocab
- http://www.tanos.co.uk/jlpt/

## Release SQLite Database

Release artifacts are generated under `releases/` by:

```sh
bun run release:package
```

The release SQLite database contains JMdict-derived dictionary data, Tatoeba
examples, estimated levels, and project-reviewed AI-assisted glosses. The
database artifact is distributed under CC BY-SA 4.0; embedded source records
retain the attribution described above.

The release package includes:

```txt
yori-dict-<dictDate>.sqlite.gz
yori-dict-<dictDate>.sqlite.gz.sha256
yori-dict-<dictDate>.json
```

## Attribution

Applications, services, and redistributed data artifacts using this database
should acknowledge JMdict/EDRDG, Tatoeba, Jonathan Waller's source lists, and
the `yomitan-jlpt-vocab` packaging project under the licenses above. A suitable
JMdict attribution is:

```txt
This product uses JMdict dictionary data from the Electronic Dictionary
Research and Development Group, distributed under CC BY-SA 4.0.
```

If the AI-assisted glosses are used, also acknowledge this project:

```txt
Some glosses include AI-assisted, project-reviewed additions from Yori Dict,
distributed under CC BY-SA 4.0.
```

For example sentences and estimated levels, also retain the Tatoeba IDs and
source links carried by the database and name the list projects above.
