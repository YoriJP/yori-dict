# The service loads a pinned data release instead of building one

`railway.json` built the database during every deploy: download JMdict, expand 248 MB of JSON, insert ~1.2M glosses, produce a 333 MB SQLite. That welded two things with completely different cadences — code changes often, dictionary data changes monthly — so fixing a typo in a route description rebuilt the entire dictionary, deploys and rollbacks were slow, and shipping a hotfix depended on GitHub being reachable. The `healthcheckTimeout: 300` was the symptom.

So the data build and the service deploy are separate. The data build runs on demand, validates via `release:check`, and publishes a versioned artifact via `package-release.ts` — both of which already existed and were only used for the public download. The service downloads the release named in `DATA_VERSION` and starts.

## Consequences

Code and data version independently: a bad route can be rolled back without touching the dictionary, and a bad data release without touching code.

The API now serves byte-identical data to what the public downloads. Previously the deployed database and the published release were built separately and could silently drift.

Deploys depend only on Yori Dict's own releases, never on JMdict upstream availability.

Rebuilds become rare rather than constant. The enrichment overlay (ADR-0002) carries new examples between releases, so a rebuild exists only to fold accumulated overlay rows into the base artifact and keep the public release current. Weekly or monthly is sufficient.

Deterministic rebuild-from-source is kept — it is the property the whole pipeline depends on. What changed is when it runs, not whether it runs.
