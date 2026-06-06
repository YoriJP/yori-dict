# yori-dict — Project Instructions

Yori is a multilingual Japanese dictionary with a canonical, product-owned data model and a `/v2` API served from an immutable SQLite release DB.

## Current Direction

- Treat the canonical snapshot as the source of truth for product data.
- Keep imported source IDs in `sourceRefs`; do not expose them as primary IDs.
- Use Yori IDs such as `yde_00000001` for entries and similar prefixes for senses, forms, readings, glosses, examples, aliases, and kanji.
- Runtime lookup should read only from the canonical release DB configured by `CANONICAL_RELEASE_DB_PATH`.
- Manual and AI corrections should be represented as canonical overlay operations and applied during rebuilds.
- Do not reintroduce the old `/admin`, `/v1`, `updates.sqlite`, or legacy JSON release workflow.

## Design Context

Future admin or curation UI should be canonical-first:

- inspect canonical entries, senses, glosses, examples, aliases, and source refs
- create manual overlay operations
- review AI overlay operations
- preview release output before publishing

Keep the interface dense, quiet, and task-focused. This is a working dictionary curation tool, not a marketing site.

Use `CANONICAL_EDITING_WORKFLOW.md` as the source of truth for replacement admin and curation workflow decisions.
