# Yori Dict

Open Japanese and English dictionaries for apps and language learning. Use the
hosted API or download the data for offline use.

Yori Dict combines open dictionary sources with reviewed AI-generated definitions
and examples. Japanese lookups handle inflected words, such as 食べました → 食べる.

## Languages

| Dictionary | Explanation languages |
| --- | --- |
| Japanese | `en`, `ja`, `zh-tw`, `zh-cn`, `ko`, `de` |
| English | `en`, `ja`, `zh-tw` |

`zh-tw` uses Taiwanese Traditional Chinese; `zh-cn` uses Simplified Chinese.
Coverage varies by word and language. The API accepts the languages above;
[`/v1/meta`](https://yori-dict-production.up.railway.app/v1/meta) lists those
with stored content.

## API

Look up a Japanese word with Traditional Chinese definitions:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=食べました&dictionary=ja&lang=zh-tw'
```

Look up an English word with Japanese definitions:

```sh
curl 'https://yori-dict-production.up.railway.app/v1/lookup?q=bank&dictionary=en&lang=ja'
```

Set `dictionary` to `ja` or `en`, and `lang` to the explanation language.
The response is an entry or `null` if no content is stored in that language.
Lookups never fall back to another language.

See the [API docs](https://yori-dict-production.up.railway.app/doc) for batch
lookups and response schemas, or use the [OpenAPI specification](openapi.yaml).

## Downloads

Japanese and English releases are published separately on the
[releases page](https://github.com/YoriJP/yori-dict/releases).

- SQLite databases for offline lookup, with SHA-256 checksums.
- JSONL exports for processing dictionary entries.
- Yomitan packs with one explanation language per ZIP, such as `yori-ja-en.zip`
  and `yori-en-ja.zip`. Import the ZIP into Yomitan to use it.

Each release manifest records its sources and coverage. Check the release notes
for available files and known issues with older downloads.

## Run locally

Requires [Bun](https://bun.sh/) 1.4.2.

```sh
git clone https://github.com/YoriJP/yori-dict.git
cd yori-dict
bun install --frozen-lockfile
bun run dev
```

No API keys are needed. The first run downloads the pinned Japanese data and
prepares the English dictionary in `data/yori.sqlite`. The API runs at
<http://localhost:3000>, with API docs at <http://localhost:3000/doc>.

## License

Code is licensed under [MIT](LICENSE). Dictionary releases are distributed
under CC BY-SA 4.0, with upstream attribution and license details in
[Data sources](DATA_SOURCES.md).
