# Yori Dict

Open Japanese and English dictionary data for apps, learning tools, and other
products.

Japanese and English are independent dictionaries. Each has its own sources,
schema, version, and release schedule. Use them through the hosted API or
download a release.

## What ships

| Dictionary | Explanation languages |
| --- | --- |
| Japanese headwords | `en`, `de`, `zh-tw`, `zh-cn`, `ko` |
| English headwords | `en`, `ja`, `zh-tw` |

Every language pair owns its own meanings, ordering, examples, and provenance.
A `zh-tw` meaning is not a translation of the `en` meaning next to it, and
`zh-tw` and `zh-cn` are separate content rather than one converted into the
other. A lookup returns the requested language's complete ordered meaning list
or nothing; it never falls back to another language.

Coverage differs by language and changes with every release. Exact per-language
entry, meaning, gloss, and example counts live in each release manifest.

## API quick start

Public API: <https://yori-dict-production.up.railway.app>

Look up an inflected Japanese word:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&dictionary=ja&lang=zh-tw'
```

Look up an English word explained in Japanese:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=bank&dictionary=en&lang=ja'
```

Look up several words in one request:

```sh
curl -X POST 'https://yori-dict-production.up.railway.app/v1/lookup/batch' \
  -H 'content-type: application/json' \
  --data '{"dictionary":"ja","lang":"ko","queries":["食べました","学校","教室"]}'
```

Every lookup must name one `dictionary` (`ja` or `en`) and one `lang`. Neither
has a default, and an unsupported pair is a request error. Single lookup returns
the entry or `null`. Batch lookup returns `entries`: one entry or `null` per
query, in the submitted order and length, without repeating the queries. `null`
means no acceptable content exists; database and provider failures stay errors.

Both dictionaries share one base entry shape — `id`, `dictionary`, `lang`,
`headword`, `headwords`, `meanings`, `sources` — while Japanese keeps its
readings and inflection path and English keeps its pronunciations. Deinflection
helps match individual Japanese words; it is not sentence parsing.

For the complete request and response schemas, use the
[interactive API documentation](https://yori-dict-production.up.railway.app/doc)
or the [OpenAPI specification](https://github.com/YoriJP/yori-dict/blob/main/openapi.yaml).

## Downloads

Each dictionary releases independently on the
[releases page](https://github.com/YoriJP/yori-dict/releases). One release
contains a canonical SQLite database and its checksum, a JSONL file with one
content group per explanation language under each entry, a manifest, and one
Yomitan v3 pack per explanation language — `yori-ja-en.zip`, `yori-en-ja.zip`,
and so on. A pack contains only the language it names, so packs for different
languages can be installed together.

Download and verify a Japanese release:

```sh
version=<version from the releases page>
curl -LO "https://github.com/YoriJP/yori-dict/releases/download/data-${version}/yori-dict-${version}.sqlite.gz"
curl -LO "https://github.com/YoriJP/yori-dict/releases/download/data-${version}/yori-dict-${version}.sqlite.gz.sha256"
shasum -a 256 -c "yori-dict-${version}.sqlite.gz.sha256"
gunzip "yori-dict-${version}.sqlite.gz"
```

The release manifest records the artifact names, checksums, source versions,
licenses, and exact per-language coverage. Its `schemaVersion` names the table
shape: `ja-2` and `en-2` are the current Japanese and English shapes.

Japanese written forms live in `ja_forms`, and meanings in `ja_senses`, which
names the explanation language:

```sh
sqlite3 "yori-dict-${version}.sqlite" \
  "SELECT g.text FROM ja_glosses g
     JOIN ja_senses s ON s.id = g.sense_id
     JOIN ja_entries e ON e.id = s.entry_id
    WHERE e.source_id = '1358280' AND s.lang = 'zh-tw'
    ORDER BY s.position, g.position;"
```

English releases use the matching `en_*` tables.

## Data and licensing

Yori Dict keeps source identities and provenance alongside its own stable entry
and meaning ids. Japanese data is based on JMdict with sourced examples,
estimated learner levels, and reviewed generated additions. English data comes
from independently licensed open dictionary sources under an explicit source
policy.

The source code is licensed under MIT. Published dictionary data and releases
are distributed under CC BY-SA 4.0, with upstream attribution and license
details in [DATA_SOURCES.md](DATA_SOURCES.md).

## Documentation

- [English dictionary](docs/english-dictionary.md) — source policy, canonical
  schema, build, and publish.
- [English source pipeline](docs/english-source-pipeline.md) — how filtered
  multilingual source evidence is produced and pinned.
- [On-demand enrichment](docs/on-demand-enrichment.md) — the lookup contract,
  owner-authorized gap filling, and runtime configuration.
- [Architecture decisions](docs/adr) — why the system is shaped this way.

## Support

Found incorrect dictionary data, an API problem, or a broken release artifact?
[Open an issue](https://github.com/YoriJP/yori-dict/issues).
