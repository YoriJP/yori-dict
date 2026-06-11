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

## Release SQLite Database

Release artifacts are generated under `releases/` by:

```sh
bun run release:package
```

The release SQLite database contains JMdict-derived dictionary data and
project-reviewed AI-assisted glosses. The database artifact is distributed
under CC BY-SA 4.0.

The release package includes:

```txt
yori-dict-<dictDate>.sqlite.gz
yori-dict-<dictDate>.sqlite.gz.sha256
yori-dict-<dictDate>.json
```

## Attribution

Applications, services, and redistributed data artifacts using this database
should acknowledge the JMdict project and EDRDG. A suitable attribution is:

```txt
This product uses JMdict dictionary data from the Electronic Dictionary
Research and Development Group, distributed under CC BY-SA 4.0.
```

If the AI-assisted glosses are used, also acknowledge this project:

```txt
Some glosses include AI-assisted, project-reviewed additions from Yori Dict,
distributed under CC BY-SA 4.0.
```
