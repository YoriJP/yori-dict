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
  resolveAll?(request: ResolveRequest): Promise<{
    item: DictionaryEntry | null;
    alternatives: DictionaryEntry[];
  }>;
};
```

`lang` is the requested explanation language. It scopes the canonical entry key, the example key, and the in-flight deduplication key, so work for one language never blocks or answers for another. Japanese authors en, de, zh-tw, zh-cn, ko, and ja; English authors en, ja, and zh-tw. Each is an independent group written directly in that language; no language is produced by translating or character-converting another. Any other requested language resolves to `null` without a model call.

The module returns existing and accepted generated content. `null` means the primary candidate was skipped, rejected, or could not be produced from acceptable content. Enrichment is exhaustive but best-effort: it attempts every missing example in the primary entry and every same-tier alternative, while preserving the original relevance order. Malformed or rejected examples receive one fresh candidate. If both candidates fail, the correct senses still return and the gap remains retryable. A provider failure while enriching one example or alternative is isolated from the other correct content; storage failures still fail the request because persisted state is uncertain.

Build-time consumers may send `X-Yori-Request-Id`. Structured lookup logs and
private model attempt records retain that trace id, so a Yori News vocabulary
request can be followed through lookup, enrichment, review, and failure without
publishing prompts or model traces.

## Lookup contract

Public lookup and owner-authorized enrichment are one route family at v1. `GET /v1/lookup` and `POST /v1/lookup/batch` both require an explicit `dictionary` and `lang`; an unsupported pair is a 400. Single lookup returns the entry or `null`; batch returns `entries` with one entry or `null` per submitted query, in order, without repeating the queries. Ordinary lookup is always model-free, including on a miss. `enrich=true` requires the owner bearer token and is checked before any model call; a token alone does not trigger generation. Database, persistence, configuration, and provider failures return 500 rather than `null` for a single lookup.

An entry carries `alternatives`: the other entries the same match reached, in the same ranking order, after the one that answered it. They come from one match tier only — a surface that is itself a word never carries the entries of what it happens to deinflect to, because that is a different reading of the input rather than another candidate for the same one. One written form is often several unrelated words — こと is both 事 and 琴, `best` is three lexemes — and ranking picks the likeliest rather than the right one, so the rest travel with it. The field is absent when there are none, which is most queries. A consumer that wants one answer reads the entry exactly as before; a popup can offer the rest. An alternative never carries its own alternatives. Enrichment attempts missing language groups and examples across the whole winning tier, including candidates ordinary lookup hides because they lack the requested language. Completeness never changes ranking: a thinner primary is not displaced by a richer alternative.

A batch is answered one query at a time. A query whose enrichment failed is `null`, the same as a miss, and the failure is recorded in the log as `lookup_failed` with that query on it. Only a failure about that one call — a dead provider, or content the model could not produce — is isolated this way. An expired key, a spent budget, and a request shape the provider rejects refuse every later query for the same reason, so they fail the whole batch at the first one rather than handing back a page of misses that are really one account-level fault. `resolve` writes attempt records and accepted entries as it goes, so narrowing the call is not enough to separate a dead provider from a failing database — the error type is what says which it was. Storage failures, wherever they are raised, still fail the request rather than reporting the word as absent. The alternative — failing the batch — meant one unavailable word discarded every entry beside it, which a consumer sending a page of text cannot afford. A batch in which *every* query failed still returns 500, because that is an expired token or a dead provider rather than a dictionary, and answering it with a full set of misses would let a consumer publish an empty artifact and believe it.

`/v1/meta` reports two lists per dictionary. `languages` is observed — the explanation languages that hold senses right now — so it moves when Enrich-on-Lookup authors a language the released data did not carry. `accepts` is the contract and does not move. A consumer choosing which locales to offer reads `accepts`; one asking what it can serve today without paying for a model reads `languages`.

### Changing the response shape

Renaming or removing a response field breaks consumers silently: the reader gets `undefined`, every word becomes a miss, and nothing raises an error. `results` → `entries` and `meanings` → `senses` both shipped this way and both cost a downstream backfill. So a change to the shape of a response — a rename, a removal, a type change — is a release note, named field by field, in the release that carries it. Adding a field is not, since nothing reading the old shape can notice.

## Resolution flow

1. Reject only obvious invalid requests: empty or multiline text, control characters, markup, URLs, or excessive length.
2. Normalize the query and use any lemma and reading supplied by the consumer.
3. Search the canonical dictionary and indexed licensed sources.
4. If all miss, ask Luna for one canonical headword or `SKIP`, using the occurrence context for disambiguation. The proposal is then checked deterministically: it must be related to the query, and it must not itself be an inflection of an entry that already exists — Japanese by deinflecting the proposal, English by stripping it. A model asked about an unknown surface will propose the surface itself, and a word form is not a lexeme.
5. When Luna changes the headword, repeat source discovery once before generating.
6. Build a source-evidence bundle and ask Luna to author one complete entry-language group for the requested language. Source evidence is minimum coverage, not a literal translation template, and the author may divide senses the way that language's dictionaries do.
7. Run deterministic schema, script, provenance, label, and Taiwan-terminology checks. Japanese glosses must contain kana and must not be the normalized headword, reading, or either plus empty boilerplate. Substantive wording that mentions the headword reaches semantic review.
8. Ask Gemini for a reject-only review that returns exactly `ACCEPT` or `REJECT`. Any other output fails closed.
9. Repeat entry-language completion for every canonical entry in the winning relevance tier. Persist each accepted group independently without changing their ranking.
10. For every sense, require at least one usable example. A Japanese Explanation Group uses a Monolingual Sense Example whose author response contains only the Japanese sentence and whose public `translations` list is empty; a redundant Japanese translation field is malformed. Other Japanese groups carry a translation in the requested explanation language. English examples do the same for `ja` and `zh-tw`; an English example under `en` needs no redundant translation. An existing example without the required language pair remains visible but does not close the gap.
11. Generate and review missing pairs independently. A malformed or rejected example receives one additional attempt. Return all correct content after every bounded attempt finishes; unresolved gaps remain retryable.

## Failure policy

- `SKIP`, deterministic rejection, semantic rejection, and malformed content all end the attempt and produce nothing. None of them is recorded, so the next lookup for that word tries again.
- A refusal is logged as `enrichment_refused` with the stage, headword, and the rule that refused it. That log line is the only record.
- Authoring and review are atomic per entry and language, so work in one language never disturbs another language's accepted content.
- Transient provider failures follow the bounded Flex retry and on-demand fallback policy in ADR-0008. Model failures while completing one example or alternative do not discard other correct entries; storage failures remain fatal.
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

One limiter bounds every model call in the process, across both dictionaries and all requests. It is therefore the ceiling on total enrichment throughput: a batch fans its queries out in parallel, a tier fans its candidates out, and an entry fans its senses out, and all of that queues behind the same slots. A consumer cannot raise its own throughput by sending more concurrent requests, so a change here is the only thing that moves a backfill.

All model calls request Flex first, and both modes end on standard rather than giving up. On-demand falls back after one Flex failure; bulk waits out a second Flex attempt first, since it can afford the delay and Flex is the cheaper tier. The SDK retry mechanism is disabled so this policy has one owner.

A retry that repeats a tier waits first, and each repeat waits longer. Flex refuses on a shortage of spare capacity rather than on anything about the request, and it does not bill the refusal, so asking again in the same millisecond meets the same shortage. A retry that escalates to a different tier has capacity waiting for it and does not pause.

Ending on standard costs more than a third Flex attempt and is worth it: an entry lost to a capacity dip is a gap that only closes if someone notices it and asks again, long after the backfill that wanted it has finished.

The per-attempt timeout is a guard against a call that will never answer, not a latency budget. Abandoning a call does not stop the work — the tokens are generated and billed either way — so a ceiling short enough to cut off calls that would have succeeded pays for an entry up to three times and stores nothing.

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
