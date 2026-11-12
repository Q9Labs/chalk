# Reproduce a partial receive stall

Reproduces a stall where one receive MID closes while the other publications stay up, comparing a pinned baseline commit against the fixed SDK. Run it on a dedicated Linux Instabox with workspace dependencies, Chromium, Go, Elixir dependencies and local Postgres/Redis. Commit and push the branch before `box run --keep`. No production or staging service is used.

Create a disposable development SFU app and deliver its credentials privately to `CHALK_DEVELOPMENT_CREDENTIALS`: a mode-0600 JSON file with `environment` set to `development`, `source` set to `chalk-local-dev`, and `appId`/`appSecret`. Never commit that file or the raw artifacts.

```sh
node scripts/dev/receive-partial-prepare.mjs
CHALK_DEVELOPMENT_CREDENTIALS=/tmp/development-sfu.json node scripts/dev/receive-partial.mjs
node scripts/dev/receive-partial-report.mjs artifacts/receive-partial
```

Preparation saves a manifest of the pinned sources, so a later HEAD change cannot relabel them. The scripts read `CHALK_PARTIAL_FIX_REF`, `CHALK_PARTIAL_SECONDS`, `CHALK_PARTIAL_VERSIONS` and `CHALK_PARTIAL_OUTPUT`; read the heads of the `.mjs` files for the scenario and the audibility rules.
