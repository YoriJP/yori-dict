# Japanese and English are independent public dictionaries

Yori Dict's product is reusable dictionary data for other people and tools. Its hosted backend exists primarily for Yori's own consumers and must not determine the shape of the public data.

Japanese and English therefore ship as independent dictionaries. Each has its own source inventory, schema details, coverage, adapters, release version, and quality evaluation. Neither is a translation layer or secondary track of the other.

The initial canonical release formats are SQLite and JSONL. Yomitan v3 is the first import adapter because it is popular and straightforward. Further adapters are added only when a real consumer needs them.

## Consequences

A Japanese release can change without forcing an English release, and consumers can depend on only the dictionary they use.

Shared code is limited to capabilities that are genuinely common: source provenance, generation attempts, review outcomes, release packaging, and adapter utilities. Language-specific sense structures and validation remain local to their dictionary.

Source datasets must be reviewed for redistribution and attribution compatibility before import. A useful source with an incompatible license is not silently copied or laundered through a model.
