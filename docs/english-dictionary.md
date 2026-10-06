# English dictionary

The English dictionary is released separately from the Japanese dictionary.
It supports definitions in English (`en`), Japanese (`ja`), and Taiwanese
Traditional Chinese (`zh-tw`). Coverage varies by language.

## Sources

Open English WordNet provides the main English definitions and examples.
Simple English Wiktionary supplies entries missing from WordNet and fills
pronunciation gaps.

Source versions and checksums are pinned in the
[source lock](../sources/english/source-lock.json), with the source archives
committed under `sources/english/raw/`. Imported content keeps its attribution;
reviewed project-authored definitions and examples keep their own provenance.
Japanese and Traditional Chinese groups have their own definitions and sense
ordering.

See [Data sources](../DATA_SOURCES.md) for licensing and attribution, and
[ADR 0011](adr/0011-english-content-follows-an-explicit-source-policy.md) for the
source selection rationale.

## Lookup

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=bank&dictionary=en&lang=ja'
```

Every request needs `dictionary=en` and an explanation language. Lookup returns
an entry or `null` when no content exists in that language, without falling back
to another language.

Inflected words can resolve to their base forms: `walls` returns `wall`, and
`rebuilt` returns `rebuild`. The response's `headword` is the matched base form.

See the [API docs](https://yori-dict-production.up.railway.app/doc) for response
schemas and batch lookup.

## Known limitation

Some short words resolve to chemical elements: `in` can return indium, and
`was` can resolve to `be` and return beryllium. WordNet has those entries but
lacks the relevant grammatical senses. Wiktionary only supplies missing
headwords, so it cannot fill those gaps in an existing WordNet entry.

## Build and export

From the repository root, build a local dictionary using the committed sources:

```sh
bun install --frozen-lockfile
bun run english:build -- --version local --out data/yori-english.sqlite
```

The build verifies source checksums and replaces the output only after the
rebuild succeeds. It needs no downloads or API keys. The default source lock
builds English definitions; rebuilding from it alone does not reproduce the
project-authored Japanese and Traditional Chinese content in published releases.

Export that database:

```sh
bun run english:release -- --db data/yori-english.sqlite --version local
```

Files are written to `releases/english/`: SQLite, a compressed copy and checksum,
JSONL, a coverage and source manifest, and one Yomitan v3 ZIP per language with
content. These commands create local files; published downloads are on the
[releases page](https://github.com/YoriJP/yori-dict/releases).
