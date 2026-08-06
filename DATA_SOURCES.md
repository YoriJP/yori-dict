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

## AI-Assisted Example Sentences

Accepted generated examples are exported from the service staging overlay to
`sources/ai-examples/generated.jsonl`. Every candidate passes deterministic sentence,
word-presence, translation, and Taiwanese-terminology checks before a separate model family
may accept it. The committed row retains generation and review provenance and is folded into
the next SQLite release. These additions are distributed under CC BY-SA 4.0.

## Source-Grounded Generated Entries

Authenticated on-demand lookup may stage a new canonical Japanese entry when
released data and indexed licensed sources do not already provide one. The
authoring prompt receives source evidence where available, deterministic checks
require every cited source meaning to remain represented, and a separate model
family performs reject-only review. Any additional model-known sense is marked
`generated` and cannot claim a source evidence ID.

`bun run enrichment:export` writes deterministic Japanese JSONL, SQLite, and
Yomitan v3 artifacts from accepted overlay rows. The export includes concise
generation provenance; these project-authored additions are distributed under
CC BY-SA 4.0.

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
