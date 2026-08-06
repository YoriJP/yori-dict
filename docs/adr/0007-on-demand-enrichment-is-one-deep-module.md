# On-demand enrichment is one deep module

The current example enrichment interface exposes its overlay and only operates after lookup finds an existing entry. Adding separate entry, eligibility, source-discovery, and example services would push orchestration into every caller and create several shallow modules.

On-demand behavior therefore lives behind one deep module. Its interface accepts a query, target dictionary, and optional occurrence context, then returns a resolved entry or no entry. The implementation owns lookup, source discovery, eligibility, generation, review, missing-example completion, and overlay persistence.

The internal flow is:

```text
normalize and deterministic request checks
-> dictionary and local source lookup
-> on miss, canonical headword or SKIP
-> repeat source lookup if canonicalization changed the headword
-> source-grounded entry authoring when still missing
-> deterministic validation and independent review
-> persist the accepted entry
-> fill missing sense examples
-> return the merged entry
```

The canonical-headword call returns exactly one line: a headword or `SKIP`. Yori News supplies the surface form, any known lemma and reading, the target dictionary, and its sentence context. English leakage, sentence fragments, names, markup, numbers, and extraction noise are skipped; genuine loanwords and initialisms used as Japanese vocabulary remain eligible.

## Consequences

Existing and generated entries share the same example-completion path. Examples attach to senses and are accepted independently; failure to create an example never invalidates an entry.

The module keeps bounded concurrency, in-flight deduplication, deterministic filters, and a staging overlay. It returns results rather than exposing overlay operations to callers.

There is no generic workflow engine, queue framework, stage DSL, or dashboard. A model gateway and enrichment repository are the only injected ports because production and test adapters both exist. Internal stages remain ordinary functions.
