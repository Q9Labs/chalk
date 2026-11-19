# Retired direct Sync trial

The former persistent Nightly host was removed on 2026-11-15 (PR #1432). This
trial is deliberately not cut over or deployed with Alchemy. The renamed
[Sync direct access declaration](../../sync-direct-access/README.md) remains for
comparison, not resurrection. No ephemeral Nightly proof needs this trial.

Runtime proxy assets and the original `opentofu/` root stay at their established
paths. Keep the original protected backend and variables so the lead can inspect
and retire any residual interface, attachment, security group or DNS records.
The root looks up its host; it must not delete that borrowed host. Follow the
[reviewed saved-plan retirement](../../migration/README.md#retire-persistent-nightly-after-merge).
Do not seed stale Nightly state, create a new backend, or run the two provisioners
as concurrent owners. Production and the shared artifacts bucket are untouched.
