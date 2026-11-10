# Releasing a dictionary

A release is a snapshot of one dictionary in the production database
(ADR-0009). Publish it on the Railway container so that only the public
artifacts leave production: the database also holds private model attempt
records.

Run the commands from a checkout linked to the `yori-dict` service
(`railway link`).

## 1. Refresh production when sources changed

Skip this step when only accepted generated content changed. Otherwise, rebuild
from the pinned sources and graft the result into production. The graft keeps
accepted generated content, so production serves the new data before it is
released.

```sh
railway ssh -- bun run english:build -- --version 2026.10.2 --out /data/english-2026.10.2.sqlite
railway ssh -- bun run db:import -- --english /data/english-2026.10.2.sqlite
railway ssh -- rm /data/english-2026.10.2.sqlite
```

## 2. Publish a draft

```sh
railway ssh -- env GITHUB_TOKEN=<token> bun run release:publish -- --dictionary en --version 2026.10.2
```

Use a fine-grained token with Contents write access to `YoriJP/yori-dict` only.
Pass it per run rather than storing it in Railway variables.

The script exports the dictionary next to the database and refuses to continue
if the release has fewer entries than the last published one. It then uploads
every artifact to a draft that targets the deployed commit, and deletes the
export. The draft body compares coverage with the last release.

## 3. Write the notes and publish

Edit the draft on GitHub: say what changed for users, then publish it. For a
Japanese release, also pin it in `data-release.json` so a fresh volume
bootstraps from it.
