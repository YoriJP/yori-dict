# Yori Dict Architecture Resources

## Knowledge

- [ADR 0005: Japanese and English are independent dictionaries](docs/adr/0005-japanese-and-english-are-independent-dictionaries.md)
  Primary source for the two-product boundary and what code may be shared.
- [ADR 0007: On-demand enrichment is one deep module](docs/adr/0007-on-demand-enrichment-is-one-deep-module.md)
  Primary source for the resolver boundary and the complete enrichment flow.
- [ADR 0008: Programmatic generation and conservative review](docs/adr/0008-programmatic-generation-and-conservative-review.md)
  Primary source for model ownership, retries, fail-closed review, and observability.
- [On-demand enrichment design](docs/on-demand-enrichment.md)
  Operational description of requests, failure behavior, runtime configuration, and export.
- [Runtime composition root](src/index.ts)
  Current code showing how databases, repositories, model gateway, concurrency limiter, resolvers, and HTTP routes are wired together.
- [Issue #18 specification](https://github.com/YoriJP/yori-dict/issues/18)
  Product requirements that motivated the architecture.

## Wisdom (Communities)

- [Yori Dict GitHub issues](https://github.com/YoriJP/yori-dict/issues)
  Use for testing an architectural explanation against real feature requests and failures.

## Gaps

- Production traffic and cost examples are not captured in this teaching workspace yet.
