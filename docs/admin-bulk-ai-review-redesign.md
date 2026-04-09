# Admin Bulk AI Review Redesign

Status note (2026-04): parts of this proposal are now implemented in the current codebase, including the queue dashboard, batch summary view, review-unit aggregation, and bulk approve/reject endpoints. Read this document as design rationale and future-direction context, not as a literal description of every current UI/API detail.

## Goal

Upgrade the current admin flow from per-item approval into an operator workflow that can safely process large volumes of AI-generated updates.

This proposal is intentionally designed around the current codebase:

- immutable release + `updates.sqlite` overlay
- separate `translation_updates` and `example_update_sets`
- AI updates require review before becoming effective
- source updates stay auto-effective

The goal is to increase review throughput without weakening release safety.

## Current State

Today the review model is technically correct, but operationally narrow.

What already exists:

- batch records for source and AI imports
- review metadata on each AI update (`pending`, `approved`, `rejected`, reviewer, notes, timestamp)
- effective lookup rules that only surface approved AI updates
- admin pages for dashboard, review queue, updates explorer, jobs, releases, and entry inspection

What blocks scale:

1. The review queue is still card-by-card.
   - `src/admin/views.ts` renders one approve/reject form per translation or example set.
2. The queue API is capped and shallow.
   - `getAiReviewQueue()` returns only pending AI items and hard-limits each list to 100.
3. Review actions are single-record mutations.
   - `/admin/api/review/translation/:id/approve`
   - `/admin/api/review/translation/:id/reject`
   - `/admin/api/review/example-set/:id/approve`
   - `/admin/api/review/example-set/:id/reject`
4. Translation and examples are reviewed separately, even when they came from the same AI run for the same word/language.
5. There is no queue segmentation by risk, batch quality, reviewer ownership, or review mode.
6. There is no sampling workflow, no bulk action, and no rule-assisted triage.

Result: the system can store a lot of AI output, but the admin surface cannot efficiently convert that output into trusted effective data.

## Design Principles

1. Keep release safety unchanged.
   - Unapproved AI data must still stay non-effective.
2. Preserve current storage primitives first.
   - Avoid a full rewrite of `translation_updates` and `example_update_sets` unless needed.
3. Move from item review to queue operations.
   - Operators should work on a batch, slice, or review unit instead of raw records one by one.
4. Separate triage from final approval.
   - High-volume review needs a fast first pass before deep inspection.
5. Make review measurable.
   - The admin should show backlog, throughput, reject rate, batch quality, and confidence bands.

## Target Operating Model

Replace the current "pending item list" with a 3-stage review system.

### Stage 1: Intake

When a Gemini import finishes:

- keep writing raw AI candidates into the existing update tables
- compute queue metadata for each candidate or candidate pair
- attach them to a review batch view

The important shift is that the admin does not immediately present a flat item list. It presents a reviewable queue.

### Stage 2: Triage

Operators first classify work before making final decisions.

Suggested triage buckets:

- `high_confidence`
- `needs_spot_check`
- `needs_deep_review`
- `blocked_by_source_conflict`
- `duplicate_or_superseded`

This stage is where scale happens. Many candidates should be resolved by batch-level or rule-level decisions, not full manual inspection.

### Stage 3: Decision

Final actions should support:

- approve selected
- reject selected
- approve whole batch segment
- reject whole batch segment
- send to deep review
- export ambiguous cases for later investigation

The approval gate remains identical to today: only `approved` AI updates become effective.

## Recommended Review Unit

Do not keep the main operator experience split into separate translation cards and example-set cards.

Introduce a logical `ReviewUnit`:

- key: `wordId + lang + batchId`
- children:
  - zero or one translation update
  - zero or one example update set
- derived fields:
  - source conflict present or not
  - already superseded or not
  - diff size
  - reviewer risk score
  - batch metadata

This can be implemented at the service layer first without changing the underlying tables.

Why this matters:

- AI usually generated both definition and examples together
- reviewers think in entry-level quality, not table-level rows
- bulk actions become much easier to reason about

## Proposed Admin IA

Replace the single AI Review page with four workflows.

### 1. Queue Dashboard

Purpose: answer "what should we review first?"

Show:

- pending count by language
- pending count by batch
- pending count by age
- reject rate / approve rate by recent batch
- source-conflicted count
- superseded count
- estimated review effort

Primary actions:

- open highest-risk batch
- open newest batch
- open sampling mode
- open deep-review bucket

### 2. Batch Review

Purpose: process large AI imports safely.

Show one batch at a time with:

- batch metadata
- language breakdown
- candidate counts
- sampled quality preview
- filter presets

Suggested filter presets:

- clean and high-confidence
- changed core meaning
- long definitions
- source conflict
- examples only
- translations only
- superseded/no-op

Bulk actions:

- approve visible
- reject visible
- assign visible to deep review
- mark visible as sampled-and-approved

### 3. Review Workspace

Purpose: inspect ambiguous units quickly.

Per unit, show:

- release value
- source update value
- AI candidate value
- effective value if approved
- side-by-side diff
- batch provenance
- review notes

Keyboard-first actions:

- `A` approve
- `R` reject
- `S` skip
- `O` open full entry inspector

### 4. Audit / Analytics

Purpose: keep quality visible after volume grows.

Show:

- approval rate by model / language / batch
- later supersede rate after approval
- promote inclusion rate
- orphaned rate
- reviewer throughput
- mean time to review

## API Changes

### Keep

Keep the current single-item endpoints for precision tools and backward compatibility.

### Add

Add bulk-first endpoints.

#### Queue endpoints

- `GET /admin/api/review/queue`
  - filters: `batchId`, `lang`, `bucket`, `risk`, `cursor`, `limit`, `reviewMode`
- `GET /admin/api/review/batches/:id/summary`
- `GET /admin/api/review/batches/:id/units`

#### Bulk mutation endpoints

- `POST /admin/api/review/units/approve`
- `POST /admin/api/review/units/reject`
- `POST /admin/api/review/units/triage`

Payload shape:

```json
{
  "unitIds": ["食べる:たべる|en|42", "飲む:のむ|en|42"],
  "notes": "batch spot-check passed",
  "actor": "admin"
}
```

The service layer can fan this out into the existing translation/example approval functions.

#### Sampling endpoints

- `POST /admin/api/review/batches/:id/sample`
- `GET /admin/api/review/batches/:id/sample-result`

This supports a workflow where a large batch is not reviewed uniformly item by item.

## Data Model Proposal

### Phase 1: Service-Layer Aggregation Only

No schema rewrite required.

Add derived structures in `src/admin/service.ts`:

- `AdminReviewQueueSummaryResponse`
- `AdminReviewBatchResponse`
- `ReviewUnit`
- `ReviewUnitFilter`

Build these by joining:

- `translation_updates`
- `example_update_sets`
- `update_batches`
- release snapshot lookup
- effective overlay lookup

This is the fastest path with the lowest migration risk.

### Phase 2: Add Queue Metadata Tables

If volume stays high, add optional queue-specific tables:

- `review_units`
- `review_unit_items`
- `review_assignments`
- `review_sampling_runs`

Use these for:

- stable queue ordering
- assignment
- triage state
- sampling history
- operator ownership

Important: keep approval state in the original update tables. Queue tables should orchestrate review, not redefine effective data rules.

## Risk Scoring Heuristics

To avoid reviewing everything equally, compute a simple risk score.

Suggested inputs:

- source conflict exists
- definition count changed sharply
- AI output is much longer than seed/source
- examples contain rare punctuation or malformed Japanese
- candidate is for high-frequency/common word
- batch/model has poor recent approval rate
- translation exists but example set is missing, or vice versa

Then bucket into:

- low
- medium
- high

This lets the admin auto-sort deep review to the top while enabling bulk approval on low-risk slices.

## Bulk Review Guardrails

Bulk review is only safe if the system prevents blind approval.

Required guardrails:

1. Never bulk-approve across mixed languages and mixed batches by default.
2. Show sample evidence before approving a whole slice.
3. Block bulk approval when source conflicts are present, unless explicitly overridden.
4. Record one admin action for the bulk command and one audit trail per affected record.
5. Support dry-run preview for bulk mutations.

## Suggested Implementation Plan

### Phase A: High-ROI, Low-Risk

Target: improve throughput without schema migrations.

Build:

- queue dashboard
- batch summary API
- `ReviewUnit` aggregation in service layer
- cursor pagination
- bulk approve/reject endpoints
- side-by-side diff card

Expected outcome:

- 3x to 10x faster review throughput
- much better batch visibility
- no change to effective lookup semantics

### Phase B: Workflow Maturity

Build:

- triage buckets
- sampling mode
- reviewer notes in UI
- keyboard-first review workspace
- batch quality analytics

Expected outcome:

- operators spend time on ambiguous work instead of obvious work
- easier quality control for large backfills

### Phase C: Organization Scale

Only do this if you truly have sustained high volume.

Build:

- reviewer assignment
- SLA tracking
- queue ownership
- auto-approval policy for low-risk slices after sampling
- model/language quality dashboards

## Concrete Code Recommendations

### `src/admin/service.ts`

Add a new review service layer instead of expanding `getAiReviewQueue()` further.

Recommended new functions:

- `getReviewQueueSummary()`
- `getReviewBatch(batchId, filters)`
- `listReviewUnits(filters)`
- `approveReviewUnits(input)`
- `rejectReviewUnits(input)`
- `triageReviewUnits(input)`

### `src/admin/routes.ts`

Keep `/admin/review`, but repurpose it as the queue dashboard.

Add:

- `/admin/review/batch/:id`
- `/admin/review/workspace`
- `/admin/api/review/queue`
- `/admin/api/review/units/*`

### `src/admin/views.ts`

Stop rendering the main review experience as raw cards from two separate tables.

Instead:

- render summary panels first
- render filter chips and saved presets
- render table/list rows for `ReviewUnit`
- open detail drawers or workspace panels for deep inspection

### `src/update-store.ts`

Short term:

- add cursor-friendly list functions
- add helpers that fetch by batch and by `(wordId, lang, batchId)` efficiently
- add bulk mutation helpers wrapped in transactions

Long term:

- only add queue tables if service-layer aggregation becomes too slow

## What Not To Do

1. Do not merge source and AI review rules together.
   - source updates should remain auto-effective unless the product policy changes.
2. Do not use release promotion as a review mechanism.
   - review decides effectiveness; promote decides baking into immutable release.
3. Do not jump straight to auto-approval.
   - first build triage, sampling, and audit visibility.
4. Do not keep scaling the current `/admin/review` card list.
   - pagination alone will not solve operator fatigue.

## Success Metrics

Track these after rollout:

- median review time per 100 AI units
- approval rate by batch
- reject rate by batch
- percent of batch handled via bulk action
- percent routed to deep review
- percent of approved AI later superseded by source update
- time from AI import completion to review completion

## Recommended Decision

The best next step for this repo is:

1. keep the current storage model
2. add a service-layer `ReviewUnit` abstraction
3. redesign `/admin/review` into batch-first queue review
4. add bulk approve/reject APIs with transaction + audit logging
5. add sampling and risk-based triage before considering any auto-approval

That path fits the current architecture, improves operator throughput quickly, and avoids unnecessary schema churn.
