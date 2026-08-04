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

## AI-Assisted Glosses

The current reviewed AI-assisted gloss sources are committed at:

```txt
sources/ai-glosses/zh-tw.jsonl
sources/ai-glosses/zh-cn.jsonl
sources/ai-glosses/ko.jsonl
```

AI-assisted glosses are generated from JMdict sense data and reviewed inside
this project before they are committed under `sources/ai-glosses/`. They are
distributed under CC BY-SA 4.0 for compatibility with the JMdict-derived data
they extend.

Simplified Chinese glosses are derived from the reviewed Traditional Chinese
source with OpenCC phrase conversion, then validated as a separate `zh-cn`
source file.

Traditional Chinese validation also rejects a reviewed policy of PRC-specific
terms. The policy derives replacements from OpenCC's `TWPhrases` mapping and
adds the audited `初中` and `幼兒園` gaps. OpenCC is deliberately not applied as a
mapping-wide rejection list: it also maps valid, context-dependent Taiwanese
words such as `進程`, and naive substring matching corrupts words such as
`聚集成群`. The check therefore uses word boundaries plus reviewed phrase
exceptions. The executable policy lives in `scripts/taiwan-terminology.ts`.

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
