# One persistent SQLite database is the canonical working dictionary

> Supersedes the runtime storage decisions in [ADR-0002](0002-enrich-on-lookup.md) and [ADR-0004](0004-service-loads-a-pinned-data-release.md).

Yori Dict is an internal lookup and background-enrichment backend whose products are independently published Japanese and English dictionary artifacts. Runtime therefore needs one durable working database, not an immutable release database plus writable overlays.

Railway mounts one volume at `/data`. `YORI_DB_PATH=/data/yori.sqlite` contains Japanese and English canonical tables, imported source provenance, accepted generated content, model attempts, terminal outcomes, and the Drizzle migration journal. Application deployment runs pending migrations and starts; it never reseeds or replaces existing dictionary data.

The first start bootstraps a missing database from the pinned Japanese release and the checksummed English sources. Later starts only apply unapplied migrations. Source refreshes are explicit and idempotent through `bun run db:import`; they preserve accepted generated content. `bun run japanese:release` and `bun run english:release` publish independent snapshots from accepted canonical data.

Japanese and English remain independent dictionary products even though they share one physical database. Their table groups, schemas, source policies, validation, and release versions remain separate.

## Consequences

- Ordinary lookup and accepted enrichment read and write one canonical store; no caller or repository merges an overlay.
- A code deployment does not download or rebuild dictionary data after bootstrap.
- SQLite keeps database cost near volume-storage cost and is sufficient for one internal writer with bounded background concurrency.
- Drizzle migrations change schema; source imports change dictionary content; releases export accepted content. These operations never implicitly trigger one another.
- Railway volume deployments may have brief downtime. Multiple replicas or independent writers are the concrete trigger to move the same model to Postgres.
- Volume backups and backward-compatible migrations protect the canonical working state.
