# On-demand dictionary enrichment

Japanese and English implementations use one `DictionaryResolver.resolve` contract. Public lookup remains model-free; authenticated lookup may use the staged enrichment path described here. Their schemas, source policies, repositories, and releases remain independent.

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
3. Search the released dictionary, enrichment overlay, and indexed licensed sources.
4. If all miss, ask Luna for one canonical headword or `SKIP`, using the occurrence context for disambiguation.
5. When Luna changes the headword, repeat source discovery once before generating.
6. Build a source-evidence bundle and ask Luna to author the canonical entry. Source evidence is minimum coverage, not a literal translation template.
7. Run deterministic schema, script, provenance, label, and Taiwan-terminology checks.
8. Ask Gemini for a reject-only review. Any issue or incomplete verdict rejects the entry.
9. Persist accepted entries in the overlay, then generate and review one example for each sense that still lacks one.
10. Return the merged entry. Example failure produces a thinner entry, not a failed lookup.

## Failure policy

- `SKIP`, deterministic rejection, semantic rejection, and malformed content are terminal.
- Transient provider failures follow the bounded Flex retry and on-demand fallback policy in ADR-0008.
- Concurrent requests for the same canonical headword or sense share one in-flight operation.
- A failed or rejected candidate is observable but never becomes dictionary data.

## Release path

The overlay is staging. `bun run enrichment:export` writes deterministic JSONL, SQLite, and Yomitan v3 artifacts with generation provenance. Those artifacts can be validated and committed as project data before they are folded into the next independent Japanese dictionary release.

## Runtime configuration

- `OPENROUTER_API_KEY` authenticates the official `@openrouter/sdk` client.
- `YORI_ENRICHMENT_TOKEN` protects `enrich=true` lookup requests.
- `YORI_ENRICHMENT_OVERLAY_PATH` selects the writable staging SQLite database.
- `YORI_ENGLISH_DB_PATH` selects the independent English release and
  `YORI_ENGLISH_ENRICHMENT_OVERLAY_PATH` selects its staging overlay.
- `YORI_JA_SOURCE_EVIDENCE_PATHS` is a comma-separated list of indexed source-evidence JSONL files.
- `YORI_ENRICHMENT_CONCURRENCY` and `YORI_MODEL_TIMEOUT_MS` bound model work.

All model calls request Flex first. On-demand transient failures fall back to standard once; bulk calls make at most three Flex attempts. The SDK retry mechanism is disabled so this policy has one owner.

Normal tests use scripted gateways and never spend model credits. `bun run enrichment:eval -- --run` is the explicit paid Japanese OpenRouter regression command. `bun run english:eval -- --run` is the independent English blind generator bake-off and reviewer calibration; false acceptance is release-blocking.

## Out of scope

- A public unauthenticated generation endpoint
- Manual review queues
- A generic workflow or queue framework
- Silent replacement of imported source facts
- Coupled Japanese and English releases
- Additional import adapters without a demonstrated consumer
