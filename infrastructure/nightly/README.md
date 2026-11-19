# Ephemeral Nightly assets

Nightly runs create their environment, execute proofs and destroy it. There is
no persistent Nightly host, stable recorder address, shared staging SFU or
always-on dispatcher. The old host and staging SFU were removed on 2026-11-15
(PR #1432 and #1453). Do not redeploy these historical resources.

This directory retains runtime templates, example environment files and the
create/delete host proof's IAM policy because scripts reference those paths.
These are assets, not a stage-specific stack root. The ordinary media proofs use
throwaway Docker stacks or a run-owned host. Runtime configuration examples must
be filled privately and use independent data and trust roots, never production
credentials or restored production data.

The [infrastructure registry](../README.md#stack-and-stage-registry) distinguishes
persistent production from `nightly-<run-id>` stages. Only the transcription
dispatcher's new release proof needs an ephemeral Alchemy stack. Its
[proof and cleanup commands](../migration/README.md#ephemeral-release-gate-for-production-cutover)
replace the old persistent-Nightly production-cutover prerequisite.

The direct Sync trial document describes a retired experiment, not a deployment
instruction. [Retirement](../migration/README.md#retire-persistent-nightly-after-merge)
is sequenced by the lead after merge; no live resource is changed by this refactor.
