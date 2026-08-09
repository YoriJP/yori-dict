# On-demand dictionary enrichment

Callers use one `OnDemandDictionary.resolve` interface. It routes internally to Japanese or English logic while public lookup remains model-free; authenticated lookup may enrich the canonical production database. Their schemas, source policies, and releases remain independent even though they share one SQLite file.

## Interface

The caller supplies a lookup candidate, not a trusted entry:

```ts
type ResolveRequest = {
  query: string;
  targetDictionary: "ja" | "en";
  lang: ApiLang;
  mode?: "on-demand" | "bulk";
  context?: {
    sentence?: string;
    lemma?: string;
    reading?: string;
  };
};

type OnDemandDictionary = {
  resolve(request: ResolveRequest): Promise<DictionaryEntry | null>;
};
```

`lang` is the requested explanation language. It scopes the canonical entry key, the example key, and the in-flight deduplication key, so work for one language never blocks or answers for another. Japanese authors en, de, zh-tw, zh-cn, and ko; English authors en, ja, and zh-tw. Each is an independent group written directly in that language; no language is produced by translating or character-converting another. Any other requested language resolves to `null` without a model call.

The module returns an existing or accepted generated entry. `null` means the candidate was skipped, rejected, or could not be produced from acceptable content. A provider outage is not a miss: it fails the resolve call, and the HTTP layer answers with an error. The one exception is a generated example, which is optional content — when an example cannot be produced the entry keeps its accepted senses and the example stays missing and retryable.

Build-time consumers may send `X-Yori-Request-Id`. Structured lookup logs and
private model attempt records retain that trace id, so a Yori News vocabulary
request can be followed through lookup, enrichment, review, and failure without
publishing prompts or model traces.

## Lookup contract

Public lookup and owner-authorized enrichment are one route family at v1. `GET /v1/lookup` and `POST /v1/lookup/batch` both require an explicit `dictionary` and `lang`; an unsupported pair is a 400. Single lookup returns the entry or `null`; batch returns `entries` with one entry or `null` per submitted query, in order, without repeating the queries. Ordinary lookup is always model-free, including on a miss. `enrich=true` requires the owner bearer token and is checked before any model call; a token alone does not trigger generation. Database, persistence, configuration, and provider failures return 500 rather than `null` for a single lookup.

An entry carries `alternatives`: the other entries the same query reached, in the same ranking order, after the one that answered it. One written form is often several unrelated words — こと is both 事 and 琴, `best` is three lexemes — and ranking picks the likeliest rather than the right one, so the rest travel with it. The field is absent when there are none, which is most queries. A consumer that wants one answer reads the entry exactly as before; a popup can offer the rest. An alternative never carries its own alternatives, and an authored entry has none, because enrichment answers a miss rather than choosing between siblings.

A batch is answered one query at a time. A query whose enrichment failed is `null`, the same as a miss, and the failure is recorded in the log as `lookup_failed` with that query on it. The alternative — failing the batch — meant one unavailable word discarded every entry beside it, which a consumer sending a page of text cannot afford. A batch in which *every* query failed still returns 500, because that is an expired token or a dead provider rather than a dictionary, and answering it with a full set of misses would let a consumer publish an empty artifact and believe it.

`/v1/meta` reports two lists per dictionary. `languages` is observed — the explanation languages that hold senses right now — so it moves when Enrich-on-Lookup authors a language the released data did not carry. `accepts` is the contract and does not move. A consumer choosing which locales to offer reads `accepts`; one asking what it can serve today without paying for a model reads `languages`.

## Resolution flow

1. Reject only obvious invalid requests: empty or multiline text, control characters, markup, URLs, or excessive length.
2. Normalize the query and use any lemma and reading supplied by the consumer.
3. Search the canonical dictionary and indexed licensed sources.
4. If all miss, ask Luna for one canonical headword or `SKIP`, using the occurrence context for disambiguation. The proposal is then checked deterministically: it must be related to the query, and it must not itself be an inflection of an entry that already exists — Japanese by deinflecting the proposal, English by stripping it. A model asked about an unknown surface will propose the surface itself, and a word form is not a lexeme.
5. When Luna changes the headword, repeat source discovery once before generating.
6. Build a source-evidence bundle and ask Luna to author one complete entry-language group for the requested language. Source evidence is minimum coverage, not a literal translation template, and the author may divide senses the way that language's dictionaries do.
7. Run deterministic schema, script, provenance, label, and Taiwan-terminology checks.
8. Ask Gemini for a reject-only review that returns exactly `ACCEPT` or `REJECT`. Any other output fails closed.
9. Persist the accepted group in the canonical database, replacing only that entry's senses in that language, then generate and review one example for each of its senses that still lacks one. A generated example carries only the sense's own language pair.
10. Return the canonical entry. Example failure produces a thinner entry, not a failed lookup.

## Failure policy

- `SKIP`, deterministic rejection, semantic rejection, and malformed content all end the attempt and produce nothing. None of them is recorded, so the next lookup for that word tries again.
- A refusal is logged as `enrichment_refused` with the stage, headword, and the rule that refused it. That log line is the only record.
- Authoring and review are atomic per entry and language, so work in one language never disturbs another language's accepted content.
- Transient provider failures follow the bounded Flex retry and on-demand fallback policy in ADR-0008.
- Concurrent requests for the same canonical headword or sense share one in-flight operation.
- A failed or rejected candidate is observable but never becomes dictionary data.

## Production data and release path

A first start bootstraps a missing database from the release pinned in `data-release.json`. A release that predates the `ja-2` schema is refused with an explicit error rather than served.

`YORI_DB_PATH` selects the single persistent SQLite database. Drizzle migrations change its schema during startup; they never seed or replace content. `bun run db:import -- --japanese <sqlite>` and `--english <sqlite>` explicitly import refreshed source releases while preserving accepted generated content. `bun run japanese:release -- --version <version>` and `bun run english:release -- --version <version>` write complete canonical SQLite, JSONL, and Yomitan v3 snapshots. Publication remains independent by dictionary.

The Japanese canonical store uses concise `ja_*` tables. `ja_senses` carries the explanation language, so an entry shares only identity and written forms while each language owns its senses, ordering, glosses, examples, and provenance. `bun run build:db` is a deliberate full rebuild: it writes a fresh file from the pinned JMdict and example inputs plus retained accepted generated and legacy content, and only replaces the previous database once it succeeds. A Japanese release publishes one canonical SQLite, one JSONL with sibling language groups under each entry, a manifest with per-language coverage and source versions, and one Yomitan pack per explanation language named `yori-ja-<lang>.zip`.

## Runtime configuration

Four variables, and no others. A value that is the same everywhere is a constant
in code, where a reader can see what actually runs.

- `OPENROUTER_API_KEY` authenticates the official `@openrouter/sdk` client. Revoking it
  is what stops all model work; there is no separate enrichment switch.
- `YORI_ENRICHMENT_TOKEN` protects `enrich=true` lookup requests. Unset refuses every
  enrichment request rather than allowing it.
- `YORI_DB_PATH` selects the canonical production SQLite database; Railway uses `/data/yori.sqlite`.
- `YORI_JA_SOURCE_EVIDENCE_PATHS` is a comma-separated list of indexed source-evidence
  JSONL files for the source-grounded authoring in ADR-0006. Nothing publishes one yet, so
  it is unset in production and authoring runs without source evidence. A path that does
  not exist fails the start.

Model concurrency, attempt timeout, the author and reviewer models, and the English source
version are pinned in code.

All model calls request Flex first. On-demand transient failures fall back to standard once; bulk calls make at most three Flex attempts. The SDK retry mechanism is disabled so this policy has one owner.

Each resolve operation that reaches a model emits one `model_run_summary` event with attempt
counts by outcome, input and output tokens, and provider-reported USD cost. It shares the
lookup trace id and does not require a separate dashboard.

Normal tests use scripted gateways and never spend model credits. `bun run enrichment:eval -- --run` is the explicit paid Japanese OpenRouter regression command. `bun run english:eval -- --run` requires at least two author and two reviewer model flags, compares author output blindly, and calibrates each reviewer; false acceptance is release-blocking.

## Out of scope

- A public unauthenticated generation endpoint
- Manual review queues
- A generic workflow or queue framework
- Silent replacement of imported source facts
- Coupled Japanese and English releases
- Additional import adapters without a demonstrated consumer
