# On-demand dictionary enrichment

Callers use one `OnDemandDictionary.resolve` interface. It routes internally to Japanese or English logic while public lookup remains model-free; authenticated lookup may enrich the canonical production database. Their schemas, source policies, and releases remain independent even though they share one SQLite file.

## Interface

The caller supplies a lookup candidate, not a trusted entry:

```ts
type ResolveRequest = {
  query: string;
  targetDictionary: "ja" | "en";
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

The module returns an existing or accepted generated entry. `null` means the candidate was skipped, rejected, or could not be produced. Operational detail belongs in attempt records and logs, not in the caller interface.

Build-time consumers may send `X-Yori-Request-Id`. Structured lookup logs and
private model attempt records retain that trace id, so a Yori News vocabulary
request can be followed through lookup, enrichment, review, and failure without
publishing prompts or model traces.

## Resolution flow

1. Reject only obvious invalid requests: empty or multiline text, control characters, markup, URLs, or excessive length.
2. Normalize the query and use any lemma and reading supplied by the consumer.
3. Search the canonical dictionary and indexed licensed sources.
4. If all miss, ask Luna for one canonical headword or `SKIP`, using the occurrence context for disambiguation.
5. When Luna changes the headword, repeat source discovery once before generating.
6. Build a source-evidence bundle and ask Luna to author the canonical entry. Source evidence is minimum coverage, not a literal translation template.
7. Run deterministic schema, script, provenance, label, and Taiwan-terminology checks.
8. Ask Gemini for a reject-only review that returns exactly `ACCEPT` or `REJECT`. Any other output fails closed.
9. Persist accepted entries in the canonical database, then generate and review one example for each sense that still lacks one.
10. Return the canonical entry. Example failure produces a thinner entry, not a failed lookup.

## Failure policy

- `SKIP`, deterministic rejection, semantic rejection, and malformed content are terminal.
- Transient provider failures follow the bounded Flex retry and on-demand fallback policy in ADR-0008.
- Concurrent requests for the same canonical headword or sense share one in-flight operation.
- A failed or rejected candidate is observable but never becomes dictionary data.

## Production data and release path

`YORI_DB_PATH` selects the single persistent SQLite database. Drizzle migrations change its schema during startup; they never seed or replace content. `bun run db:import -- --japanese <sqlite>` and `--english <sqlite>` explicitly import refreshed source releases while preserving accepted generated content. `bun run japanese:release -- --version <version>` and `bun run english:release -- --version <version>` write complete canonical SQLite, JSONL, and Yomitan v3 snapshots. Publication remains independent by dictionary.

## Runtime configuration

- `OPENROUTER_API_KEY` authenticates the official `@openrouter/sdk` client.
- `YORI_ENRICHMENT_TOKEN` protects `enrich=true` lookup requests.
- `YORI_DB_PATH` selects the canonical production SQLite database; Railway uses `/data/yori.sqlite`.
- `YORI_ENGLISH_DICTIONARY_VERSION` selects the English source version used only when a new database is bootstrapped.
- `YORI_ENGLISH_AUTHOR_MODEL` and `YORI_ENGLISH_REVIEW_MODEL` explicitly enable the
  English configuration selected by the blind comparison; English enrichment remains off
  when either is absent.
- `YORI_JA_SOURCE_EVIDENCE_PATHS` is a comma-separated list of indexed source-evidence JSONL files.
- `YORI_ENRICHMENT_CONCURRENCY` globally bounds combined Japanese and English model work;
  `YORI_MODEL_TIMEOUT_MS` bounds each attempt.

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
