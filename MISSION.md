# Mission: Understand Yori Dict after issue #18

## Why
Understand how the current Yori Dict system works after the issue #18 changes, so its behavior is predictable when reading code, debugging a lookup, or changing the architecture.

## Success looks like
- Explain why Japanese and English are separate dictionary products
- Trace an ordinary lookup and an authenticated enrichment lookup
- Identify where model calls, validation, review, and persistence happen
- Explain how accepted canonical data becomes a reproducible release

## Constraints
- Use simple language before implementation detail
- Ground explanations in the current repository, not an idealized design
- Keep each lesson short enough to review in one sitting

## Out of scope
- Prompt tuning and model-quality evaluation details
- Every field in the Japanese and English schemas
- Deployment-provider operations unrelated to the architecture
