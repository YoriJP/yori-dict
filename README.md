# Yori Dict

Open Japanese and English dictionary data for apps, learning tools, and other
products.

Yori Dict publishes Japanese and English as independent dictionaries, each with
its own sources, schema, and release lifecycle. The hosted API is the quickest
way to use both dictionaries. The Japanese dictionary is also available as a
downloadable SQLite database.

## Dictionaries

| Dictionary | Available through | Includes |
| --- | --- | --- |
| Japanese | Hosted API and SQLite release | Kanji, kana, word-level deinflection, multilingual glosses, sense annotations, examples, unofficial estimated JLPT bands, and inflection paths |
| English | Hosted API | Definitions, pronunciations, parts of speech, usage labels, examples, and source provenance |

Explanation languages:

```txt
ja: en, de, zh-tw, zh-cn, ko
en: en
```

English and German Japanese glosses come from JMdict. Traditional Chinese,
Simplified Chinese, and Korean coverage is partial and includes reviewed
generated glosses. A lookup returns only the meanings written in the requested
language; it never falls back to another language.

## API Quick Start

Public API: <https://yori-dict-production.up.railway.app>

Look up an inflected Japanese word:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&dictionary=ja&lang=zh-tw'
```

Look up an English word:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=bank&dictionary=en&lang=en'
```

Look up several Japanese words in one request:

```sh
curl -X POST 'https://yori-dict-production.up.railway.app/v1/lookup/batch' \
  -H 'content-type: application/json' \
  --data '{"dictionary":"ja","lang":"ko","queries":["食べました","学校","教室"]}'
```

Every lookup must name one `dictionary` (`ja` or `en`) and one `lang`. Neither
has a default, and an unsupported pair is a request error. Single lookup
returns the entry or `null`. Batch lookup returns `entries`: one entry or
`null` per query, in the submitted order and length, without repeating the
queries. `null` means no acceptable content exists; database and provider
failures stay errors. Both dictionaries share one base entry shape — id,
dictionary, lang, headword, headwords, meanings, sources — while Japanese keeps
its readings and inflection path and English keeps its pronunciations.
Deinflection helps match individual Japanese words; it is not sentence parsing.

For the complete request and response schemas, use the
[interactive API documentation](https://yori-dict-production.up.railway.app/doc)
or the [OpenAPI specification](https://github.com/YoriJP/yori-dict/blob/main/openapi.yaml).

## Japanese SQLite Release

This example uses the pinned
[`data-2026-08-04.3`](https://github.com/YoriJP/yori-dict/releases/tag/data-2026-08-04.3).
Download and verify it with:

```sh
version=2026-08-04.3
curl -LO "https://github.com/YoriJP/yori-dict/releases/download/data-${version}/yori-dict-${version}.sqlite.gz"
curl -LO "https://github.com/YoriJP/yori-dict/releases/download/data-${version}/yori-dict-${version}.sqlite.gz.sha256"
shasum -a 256 -c "yori-dict-${version}.sqlite.gz.sha256"
gunzip "yori-dict-${version}.sqlite.gz"
```

Inspect a dictionary form with the `sqlite3` CLI:

```sh
sqlite3 "yori-dict-${version}.sqlite" \
  "SELECT text, reading, kind, common FROM ja_forms WHERE text = '食べる';"
```

Meanings live in `ja_senses`, which names the explanation language. Read one
language's meanings without mixing in another:

```sh
sqlite3 "yori-dict-${version}.sqlite" \
  "SELECT g.text FROM ja_glosses g
     JOIN ja_senses s ON s.id = g.sense_id
     JOIN ja_entries e ON e.id = s.entry_id
    WHERE e.source_id = '1358280' AND s.lang = 'zh-tw'
    ORDER BY s.position, g.position;"
```

Each release also publishes one Yomitan pack per explanation language, named
`yori-ja-en.zip`, `yori-ja-zh-tw.zip`, and so on. A pack contains only the
language it names, so packs for different languages can be installed together.

Exact per-language record counts and source metadata are recorded in the release
manifest:

```sh
curl -LO "https://github.com/YoriJP/yori-dict/releases/download/data-${version}/yori-dict-${version}.json"
```

See [all releases](https://github.com/YoriJP/yori-dict/releases) for newer
versions.

## Data and Licensing

Yori Dict preserves source identities and provenance alongside its own stable
entry and sense IDs. Japanese data is based on JMdict and also includes sourced
examples, estimated learner levels, and reviewed generated additions. English
data combines independently licensed open dictionary sources without coercing
them into the Japanese schema.

The source code is licensed under MIT. Published dictionary data and SQLite
releases are distributed under CC BY-SA 4.0, with upstream attribution and
license details documented in [DATA_SOURCES.md](DATA_SOURCES.md).

## Support

Found incorrect dictionary data, an API problem, or a broken release artifact?
[Open an issue](https://github.com/YoriJP/yori-dict/issues).
