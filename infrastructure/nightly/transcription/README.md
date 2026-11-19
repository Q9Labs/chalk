# Dispatcher entrypoint

This entrypoint serves Nightly and production through the same
[Alchemy stack](../../alchemy/dispatcher/README.md). Select `--stage nightly` or
`--stage production`. Inputs come from that environment's explicitly seeded
Alchemy stack output, not tfvars or an OpenTofu backend.

Use the guarded release commands for code and MAI changes. For a read-only plan:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx alchemy/dispatcher/driver.ts plan nightly
```

The driver refuses an unseeded environment. See the
[release and rollback runbook](../../../docs/transcription-production-release.md).
