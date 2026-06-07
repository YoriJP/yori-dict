# Canonical Editing Workflow

This document defines the replacement workflow for dictionary curation after the old admin, `/v1`, and `updates.sqlite` paths are removed.

The replacement is canonical-first. Human and AI edits do not mutate the runtime database directly. They create canonical overlay operations, those operations are reviewed, then approved operations are applied during a rebuild before a release DB is promoted.

## Goals

- Let maintainers correct glosses, examples, and entries without editing imported source data.
- Keep manual and AI changes stable across JMdict, KANJIDIC2, Tatoeba, and Wiktionary rebuilds.
- Make every non-source change traceable through `sourceRefs`.
- Keep the first version small enough to maintain without rebuilding the old admin.
- Give a future curation UI a clear contract to call.

## Non-Goals

- Do not bring back the old admin dashboard, `/v1` API, `updates.sqlite`, or legacy JSON release pipeline.
- Do not let the website write directly to the canonical release DB.
- Do not create a second dictionary schema for admin edits.
- Do not auto-publish AI output without human approval.

## Source Of Truth

The canonical data flow stays:

```text
source imports
  -> canonical snapshot
  -> approved manual/AI overlays
  -> validated snapshot
  -> canonical SQLite release DB
  -> /v2 API
```

The runtime `/v2` API reads only from the immutable SQLite release DB configured by `CANONICAL_RELEASE_DB_PATH`.

Curated edits are stored as `CanonicalOverlayFile` operations:

- `addGloss`
- `replaceGlosses`
- `addExample`
- `upsertEntry`

Each operation has:

- `id`: stable operation ID
- `sourceKind`: `manual` or `ai`
- `importedAt`: when the operation was created
- `reviewStatus`: `unreviewed`, `approved`, or `rejected`
- AI-only metadata: `model`, `promptVersion`, and `inputRefs`

Only `reviewStatus: "approved"` operations are applied to release snapshots.

## Operation ID Rules

Overlay operation IDs are not public dictionary IDs. They are audit IDs for curation actions.

Use stable, readable IDs:

```text
manual-<entity-id>-<action>-<lang>-<date>
ai-<entity-id>-<action>-<lang>-<prompt-version>-<date>
```

Examples:

```text
manual-yds_00000001-replace-glosses-zh-tw-20260604
ai-yds_00000001-add-gloss-en-canonical-gloss-v1-20260604
```

Once an operation is approved and used in a release, do not rewrite its meaning. If a correction changes again, add a new operation that supersedes the old result.

## Manual Correction Workflow

1. Find the target entry or sense.
   - Use `/v2/lookup` for surface, lemma, or reading lookup.
   - Use `/v2/entries/:id` to inspect the full canonical entry.
   - Use source refs to understand where the current content came from.

2. Create a manual overlay operation.
   - Use `replaceGlosses` when the current glosses for one language are wrong or messy.
   - Use `addGloss` when adding a missing gloss without removing source glosses.
   - Use `addExample` when adding a reviewed example sentence.
   - Use `upsertEntry` only for entries that cannot be represented by source imports.

3. Review the operation.
   - Check the target `senseId`, language, text, and source refs.
   - Confirm the edit does not hide a source import bug that should be fixed upstream.
   - Set `reviewStatus` to `approved` only after review.

4. Rebuild and validate.
   - Run the canonical rebuild with the overlay file.
   - Validate the snapshot.
   - Run the quality report.
   - Build the release DB.
   - Smoke test `/v2/lookup` and `/v2/entries/:id`.

## AI Suggestion Workflow

AI output is a suggestion, not dictionary data.

1. Build a curation queue with `bun run queue:curation`.
2. Generate suggestion JSONL with `bun run generate:ai-suggestions`.
3. Convert suggestion JSONL into overlay operations with `reviewStatus: "unreviewed"` using `bun run suggest:ai-overlays`.
4. Include required AI metadata:
   - `model`
   - `promptVersion`
   - `inputRefs`
5. Show reviewers the candidate text, target entry, target sense, source refs, and prompt version.
6. Reviewer chooses one of:
   - approve as-is
   - edit and approve as a manual operation
   - reject
7. Only approved operations enter the release rebuild.

Rejected AI operations may be kept for audit, but they must never affect the release because the overlay applier skips unapproved operations.

## Future Curation UI Contract

The first replacement admin should be a thin curation tool over the overlay model. It should not own a separate dictionary store.

Minimum useful screens:

- Search canonical entries by surface, lemma, reading, or ID.
- Inspect entry details, senses, glosses, examples, aliases, and source refs.
- Create manual overlay operations.
- Review AI overlay operations.
- Preview overlay effects before release.
- Show validation and quality report output for the candidate release.

If internal HTTP endpoints are added later, keep them scoped to curation:

```text
GET  /admin/curation/lookup
GET  /admin/curation/entries/:id
GET  /admin/curation/overlays
GET  /admin/curation/overlays/:id
POST /admin/curation/overlays/:id/approve
POST /admin/curation/overlays/:id/reject
```

Those endpoints should read canonical snapshots or release DBs, write overlay operations, and run validation. They should not mutate release DB rows directly.

The first HTTP version is intentionally smaller than a replacement admin UI. It
requires `CURATION_OVERLAY_PATH` and `CURATION_API_TOKEN`, supports lookup,
entry inspection, overlay listing, overlay inspection, and approve/reject. Manual
operation creation and release preview stay in the CLI until the review workflow
is stable.

## Release Gate

A canonical release can be promoted only when all of these pass:

- overlay file validation
- overlay apply validation for approved operations
- canonical snapshot validation after overlays
- quality report generated
- release DB build succeeds
- release manifest written with artifact hashes
- `/v2/lookup` smoke tests pass for edited entries
- `/v2/entries/:id` smoke tests pass for edited entries
- TypeScript typecheck passes
- test suite passes

## Implementation Phases

1. Document and freeze the workflow contract.
   - Keep this document as the reference for the replacement admin.
   - Avoid adding UI or storage before the contract is stable.

2. Add overlay authoring utilities.
   - Generate valid operation IDs.
   - Create manual `addGloss`, `replaceGlosses`, and `addExample` operations.
   - Validate AI metadata before writing AI suggestions.

3. Add release preview tooling.
   - Apply overlays to a temp snapshot.
   - Build a temp release DB.
   - Run focused smoke lookups for edited entries.

4. Add the minimal curation UI or internal API.
   - Build against the overlay contract.
   - Keep authentication separate from dictionary data logic.
   - Keep release promotion explicit.

5. Add release promotion metadata.
   - Record source versions, overlay file hash, quality report path, build time, and release DB path.
   - Write a manifest with `bun run release:manifest:canonical`.

## Risks And Trade-Offs

- A JSON overlay file is simple and reviewable, but it needs good ID and merge discipline.
- Keeping rejected AI operations is useful for audit, but it can make the overlay file noisy.
- `upsertEntry` is powerful and should be rare because it replaces larger entry structures.
- A UI will improve reviewer speed, but adding it before the overlay workflow is stable would recreate the old maintenance problem.
- Manual corrections can hide importer bugs. During review, decide whether a correction belongs in an overlay or in a source converter fix.
