# The service loads a pinned data release instead of building one

> Superseded for runtime deployment by [ADR-0009](0009-one-persistent-production-database.md). Pinned releases remain bootstrap and publication artifacts; ordinary deployments retain the production database.

> Current bootstrap note: `data-release.json` pins the Japanese release. There is
> no `DATA_VERSION` runtime variable. A missing production database downloads
> and verifies that pin; later starts retain the database and apply migrations.

`railway.json` built the database during every deploy: download JMdict, expand 248 MB of JSON, insert ~1.2M glosses, produce a 333 MB SQLite. That welded two things with completely different cadences — code changes often, dictionary data changes monthly — so fixing a typo in a route description rebuilt the entire dictionary, deploys and rollbacks were slow, and shipping a hotfix depended on GitHub being reachable. The `healthcheckTimeout: 300` was the symptom.

The original decision separated the data build from the service deploy. The data
build ran on demand, validated via `release:check`, and published a versioned
artifact via `package-release.ts` — both of which already existed and were only
used for the public download. At that time, the service downloaded the release
named in `DATA_VERSION` and started. ADR-0009 later replaced that runtime path
with the persistent-database and `data-release.json` bootstrap described above.

## Original consequences

Code and data could version independently: a bad route could be rolled back without touching the dictionary, and a bad data release without touching code.

The freshly deployed API served byte-identical data to the public download. Previously the deployed database and the published release were built separately and could silently drift.

Deploys depended only on Yori Dict's own releases, never on JMdict upstream availability.

Rebuilds became rare rather than constant. Under the then-current overlay design
in ADR-0002, a rebuild only had to fold accumulated overlay rows into the base
artifact and keep the public release current. ADR-0009 later replaced that
overlay with canonical persistence.

Deterministic rebuild-from-source remained a requirement; what changed was when it ran, not whether it ran.
