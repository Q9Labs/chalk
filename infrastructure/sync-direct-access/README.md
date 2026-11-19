# Sync direct access

Provided direct client connectivity to the former persistent Nightly Sync host.
The trial retires with that host (removed 2026-11-15, PR #1432); no ephemeral
proof needs it. It was ported but deliberately not cut over or deployed.

`alchemy.run.ts` refuses deploy; `config.ts` validates private inputs through
`CHALK_INFRA_INPUTS`. The runnable [OpenTofu root and runtime proxy](../managed-episode/direct-sync/README.md)
stay at their established paths until retirement. See the [saved-plan cleanup](../migration/README.md).
