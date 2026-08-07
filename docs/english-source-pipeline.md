# English multilingual source pipeline

This pipeline produces the source evidence needed to author Japanese and Taiwanese
Chinese explanations for English headwords. It produces evidence and measurements
only. It publishes no canonical entries and makes no model calls.

```sh
bun run english:evidence
bun run english:evidence -- --archive path/to/en-extract.jsonl.gz --no-download
```

## Why the full English extract

The pinned Simple English Wiktionary extract has no translation records, so the
pipeline reads the full English Wiktextract archive instead. That archive was about
2.65 GiB compressed when researched and is never committed.

`sources/english/wiktionary-full-lock.json` pins the upstream URL, dump date, license,
attribution, expected checksum, and the ignored cache path. The default cache lives under
`data/wiktionary/`, which `.gitignore` excludes. Downloading is an operator action:
`ensureCachedArchive` resumes a partial download with an HTTP range request and stores
status, ETag, last-modified, content length, content type, and retrieval time in a
`.meta.json` sidecar beside the cache.

The archive is streamed once. Compressed bytes are hashed as they pass through the
decompressor, so the manifest records the checksum of the archive that was actually read.
Only one JSONL line is ever held in memory. Filtering stops emitting rows at `--max-rows`
but keeps draining the stream, so a capped run still reports the whole-archive checksum
and sets `coverage.truncated`.

Pin the reported checksum into the lock's `sha256` after the first download. Once pinned,
a mismatch fails the run.

## Artifacts

`bun run english:evidence` writes two files into `sources/english/evidence/`:

- `wiktionary-en-<dump-date>-ja-zh.jsonl`, the bounded filtered evidence
- `manifest.json`, holding upstream identity, checksum, compressed size, dump date,
  HTTP metadata when available, license, attribution, tool name and version, filter
  settings, mapped-source provenance, the evidence file's own checksum, and coverage

Both stay outside canonical SQLite and JSONL releases. A repeat run over the same pinned
archive with the same tool version produces byte-identical files; bump
`evidenceToolVersion` in `scripts/english-evidence.ts` when the filter's output changes.

Each evidence row keeps a stable `sourceEntryId` built from source, dump date, page,
part of speech, etymology number, and occurrence, plus the source page id and sense id
where Wiktextract supplies them. It also keeps the source meaning text and its index, the
translation's location and order within the entry, the target language and locale, the
term, romanization, and qualifiers, and whether the record was `sense-local` or
`entry-level`.

## The independent-language rule

A Japanese or Chinese translation nested under an English meaning is evidence for
authoring and review. It has no target-language meaning structure of its own, so every
emitted row carries `role: "authoring-evidence"` and `directImportEligible: false`.

`classifySourceRecord` in `scripts/english-evidence-sources.ts` is the direct-import gate.
A record may become canonical target-language content only when all of these hold:

- the source supplies its own target-language meaning structure
- the record's locale equals the target locale
- the match is an exact source identifier or an explicit maintained mapping, never a
  string or reverse-gloss match
- redistribution license, attribution, source version, and record id are all recorded

Reverse JMdict, CC-CEDICT, Simplified Chinese WordNet, and Wiktionary translation lists
are permanently supporting evidence. NTU Chinese Wordnet is restricted: without a
documented permission grant its records are rejected outright.

## Mapped sources

Japanese WordNet evidence is admitted only through a validated Princeton WordNet/ILI
mapping. Every accepted row keeps the ILI id, the PWN synset, the mapping source, and the
mapping version. Unmapped or unvalidated records are rejected with a reason. Japanese
WordNet is old and warns that translated definitions and examples may contain errors, so
its version and mapping provenance stay attached.

Taiwan government terminology is domain-specific evidence. Every row keeps its agency,
dataset, domain, version, attribution, and the exact English/Chinese term pair; a record
missing any of those is rejected as incomplete provenance. A bare term pair corroborates
wording but is not a direct-import candidate, because it carries no Taiwanese meaning text.

Both mapped sources are configured in the lock and point at operator-supplied downloads.
A configured but absent file is skipped with a warning so the Wiktionary filter still runs.

## Taiwanese labelling

`zh-tw` is assigned only when Taiwan government terminology corroborates the exact term.
Traditional characters alone stay `zh-hant`; Simplified stays `zh-hans`; other Chinese
variants keep their own code, such as `nan`. Character form is not localization.

## Coverage

`manifest.json` reports, separately for Japanese and Chinese: `senseLocal`, `entryLevel`,
`ambiguous`, `corroborated`, `unmatched`, `rejected`, and `rejectionsByReason`. Scope
(`senseLocal`/`entryLevel`) and corroboration (`corroborated`/`unmatched`) are independent
axes over the same accepted rows; `rejected` counts records dropped before emission.

Rejected records are dropped for a missing term, malformed placeholder text, or the wrong
script. Ambiguous records are kept as evidence and flagged: a record listing several terms
at once, or an entry-level record that cannot be attributed to a single source meaning.
Ambiguity blocks direct publication; it does not delete evidence.
