# Media provider inventory

`apps/api/cmd/media-provider-inventory` is the audited query set for
[M12](milestones.md#m12--full-cutover-and-monitoring-parity)
package 1 and the post-cutover checks. It counts Tenants, Spaces, live
Episodes and recording dependencies by media provider (`cf_sfu`, `chalk_sfu`)
and prints sanitized counts only.

## Run

```sh
CHALK_DATABASE_URL=… go run ./cmd/media-provider-inventory --allowed-spaces "$CHALK_SFU_ALLOWED_SPACES"
```

Run it from `apps/api`. JSON goes to stdout and a short table to stderr. The
command reads in one read-only, repeatable-read transaction, so every count
comes from one snapshot and nothing is written. `--timeout` (default 1 minute,
at most 5) bounds the whole command and each statement.

`--allowed-spaces` must state the `CHALK_SFU_ALLOWED_SPACES` value the API
runs with (`*`, comma-separated Space IDs, or empty for none), either as the
flag or as that environment variable. The API pins a `chalk_sfu` Space outside
the allowlist to Cloudflare, so a wrong value gives wrong counts and the
command refuses to guess. The report records only the mode (`all`, `listed`,
`none`) and the number of listed Spaces, which follows the same `"<5"` rule.

## Sanitizing

The output has no Tenant or Space identifiers, names, emails or rows. A count
of 1 to 4 prints as `"<5"`, and zero prints as `0`. No total is printed. The
families of one population (for example the three Tenant families) sum to the
same hidden total, so a hidden cell could be read off another family. Whenever
any cell is hidden, every family of the population also prints `"withheld"`
for its smallest remaining non-zero cell (its count is 5 or more, possibly far
more), so the hidden cells add up to an unknown amount. That
makes a hidden count unrecoverable except when the partner is itself a count
just above 5. Read the output as internal until a person has checked it against
the Tenant list, and do not publish more than the command prints.

## What each count means

The classification mirrors `apps/api/internal/adapters/mediaplaneproviders`
(`selectedProvider`, `resolveProviderConfig`, `ResolveBinding`). Change one
and change the other. Tests in
`apps/api/cmd/media-provider-inventory/inventory_test.go` seed each case on
Postgres.

**Configuration source** is how a Tenant's `media_plane_provider_config`
reads: `deployment_default` (empty), `tenant_chalk_managed`, `tenant_managed`
(the Tenant's own Cloudflare credentials), `disabled` (`enabled: false`, so
new Episodes have no media) and `invalid` (malformed document, unknown provider
or mode).

**Tenants** are counted `by_default_media_plane` (`default_media_plane`:
`cf_sfu`, `chalk_sfu`, `none` when unset, `unknown`), `by_configuration_source`,
and `by_space_selection`: whether the Tenant has any non-archived Space that
selects Cloudflare or that the allowlist pins to it, the Tenants a Cloudflare
removal still touches.

**Spaces** exclude archived ones, counted separately in `archived`:

- `by_selection` is what the Space selects: its own plane (`space_*`: its
  `media_plane_setting`, else a stored `chalk_sfu`, which the API still honors for
  Spaces stored before the setting existed), or the Tenant default when it has
  none (`tenant_default_*`), or `none`. A `space_cf_sfu` cell is an explicit
  Space-level override. The inventory does not read `CHALK_SFU_NEW_EPISODES`: with
  the kill switch off every new Episode binds to Cloudflare whatever these cells say.
- `by_new_episode_provider` is what the API would bind a new Episode to.
  `cf_sfu_by_allowlist` is a Space that selects `chalk_sfu` but is outside the
  allowlist. A `chalk_sfu` Space inside the allowlist under a tenant-managed
  Tenant counts as `cf_sfu`, as live resolution does. `none` is no provider selected or media disabled.
  `unresolvable` is a Space the API refuses to bind: unknown provider, invalid
  Tenant settings, a tenant-managed Tenant selecting `chalk_sfu` (it has no
  tenant-managed mode), or tenant-managed settings with no Cloudflare SFU
  section or a different provider. Settings are `invalid` when a field has a
  type the API cannot read (for example a numeric `app_id`); credential values
  are not inspected.
  Cutover is complete when every cell but `chalk_sfu` and `none` is zero.
- `by_configuration_source` counts Spaces by their Tenant's source.
- `cloudflare_by_configuration_source` splits the Spaces that still select
  Cloudflare, or select `chalk_sfu` outside the allowlist, by source. A `tenant_managed` cell cannot move without a
  Tenant settings change.

**Episodes** use the provider in `episodes.config_snapshot`
`media_plane_binding`: `cf_sfu`, `chalk_sfu`, `legacy_cf_sfu` (no binding key,
which the API treats as Cloudflare), `none` (null binding), `other`,
`unreadable`. `live_by_bound_provider` counts `active` and `ending` Episodes,
which stay pinned until they finish. `created_last_24h_by_bound_provider`
shows what new traffic bound to.

**Dependencies** use the bound provider of the Episode that owns the artifact,
because capture authority comes only from that snapshot. `cf_sfu` plus
`legacy_cf_sfu` is the Cloudflare dependency.

- `recordings_by_bound_provider` counts every Recording.
- `recording_pipelines_in_flight_by_bound_provider` counts pipelines whose
  capture is not finished: `requested`, `reserved`, `capture_leased`,
  `capturing_segmented` or `retryable_failure` (a retry may capture again).
  Render and verify states no longer need the provider and are not counted.
- `transcriptions_in_flight_by_bound_provider` counts Transcriptions in
  `preparing`, `transcribing`, `verifying` or `retryable_failure`.

## Not measured

The database cannot show the per-request client check (an SDK that cannot run
the own SFU gets Cloudflare), `CHALK_SFU_CLOUDFLARE_OVERFLOW` (a full own-SFU
pool starts the Episode on Cloudflare while it is on), or the deployment
default provider. Traffic counts, `created_last_24h_by_bound_provider` and the
telemetry in [observability](../observability.md), show their effect.
