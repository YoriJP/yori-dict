# Gaps are filled on lookup, into a staging overlay

> Superseded by [ADR-0009](0009-one-persistent-production-database.md). Enrich-on-lookup remains; accepted content now writes to the canonical production database rather than an overlay.

> Amended by [ADR-0007](0007-on-demand-enrichment-is-one-deep-module.md): lookup enrichment now also covers missing entries, while preserving the overlay and failure-isolation decisions here.

Yori Dict owns everything intrinsic to a word, and an example sentence is intrinsic to a word. So Yori Dict fills its own gaps: when a lookup asks for a word with no example and the caller is authorized to enrich, it generates one, runs it through the deterministic filter and the reviewer, writes it to the enrichment overlay, and returns the entry complete.

The overlay is a small writable store alongside the read-only data release. Lookup reads both. It is staging, not truth — it is periodically exported to `sources/ai-examples/*.jsonl`, committed, and folded into the next data release, after which those rows are redundant. Losing the overlay costs at most the unexported window, which regenerates on the next lookup.

## Considered options

**Batch enrichment over a scope Yori Dict picks for itself** (entries JMdict marks common, plus the JLPT list) was designed and rejected. The cost argument for it was sound — the difference between eager and lazy is a few dollars, once — but the scope rule is the problem, not the cost. It is a rule someone has to invent, maintain, and re-run when it changes, and it would have been scoped to one consumer's vocabulary. Yori Dict is a public dictionary with other consumers. Enrich-on-lookup needs no scope at all: use defines it, and every consumer expands the dictionary for every other consumer.

**Generation in the consumer, written back to Yori Dict**, was also designed and rejected. It put dictionary-generation logic, two extra model credentials, and a cross-repo push inside an article-publishing pipeline, for work that belongs here.

## Consequences

Enrichment must be authenticated. The API is public, so an unauthenticated enrich path is an open drain on the model budget. Ordinary reader traffic never requests it.

Misses within a request are generated with bounded concurrency and **no cap**. Enrichment attempts every missing example across the primary match and its same-tier alternatives. A malformed or rejected example receives one additional candidate; if both fail, correct content still returns with the gap visible and retryable. For translated groups, an example closes the gap only when it carries a non-empty translation in the requested language. English-under-English needs only its English example. Relevance remains authoritative, so completeness never promotes an alternative over the primary.

The first lookup of a word is slow and every later one is instant. This is acceptable because the enriching caller is a build-time batch job, not reader traffic.

The overlay requires a volume, and a Railway service with a volume cannot run replicas. That is fine at current scale. If the read API ever needs to scale horizontally, enrichment moves to a second service and the read path goes stateless again.

Boot must not require the overlay to exist. A missing or fresh volume degrades to "no recent enrichment," never to a service that will not start.
