# Own-SFU nodes

This root applies the [SFU node module](../../features/media/sfu/infra) once per
environment, staging and production, each with its own state. Real addresses,
state settings and certificates stay outside Git, in `~/.config/chalk-sfu/<env>`
and 1Password.

## Build or rebuild a node

1. Copy `backend.hcl.example` and `node.tfvars.example` to the private directory
   and fill them in. `control_addresses` lists the API host's public addresses,
   the only ones that may reach the control port.
2. Apply with a separate data directory per environment, then save the node's
   address as `address` in the private directory:

   ```sh
   export TF_DATA_DIR=~/.config/chalk-sfu/staging/.terraform DIGITALOCEAN_TOKEN="$(doctl auth token)"
   tofu -chdir=infrastructure/sfu init -backend-config=$HOME/.config/chalk-sfu/staging/backend.hcl
   tofu -chdir=infrastructure/sfu apply -var-file=$HOME/.config/chalk-sfu/staging/node.tfvars
   tofu -chdir=infrastructure/sfu output -raw public_ip
   ```

3. Issue certificates once per environment (`deploy/certs staging ca`, then
   `deploy/certs staging server`), then deploy:

   ```sh
   SFU_SSH_KEY=~/.ssh/chalk-sfu-operator_ed25519 features/media/sfu/deploy/deploy staging "$(cat ~/.config/chalk-sfu/staging/address)"
   ```

To change `control_addresses` or `ssh_addresses`, widen first and narrow
second, because the cloud firewall and the node's own firewall both filter SSH
and only a deploy run brings the node's firewall into line:

1. Apply with the old and the new addresses both listed, then run
   `deploy <env> <address> --firewall-only`.
2. Check the node is reachable from the new address (SSH, and the API's control
   calls for `control_addresses`).
3. Apply with the old address removed, then run `--firewall-only` again.

Applying a straight swap locks out both: the cloud firewall drops the old
address while the node's firewall still drops the new one, so no run can reach
the node to fix it. `--firewall-only` changes no running calls.

To replace a broken node, taint the Droplet, apply, update `CHALK_SFU_NODES` in
the API's settings if the address changed, and deploy. The node ID the API
records stays the same, so bound Episodes still name it.

## Upgrade order

The SFU decodes requests strictly, so a field the API adds is refused as
`400 invalid_request` by a node that predates it. Each node reports its wire
protocol and build commit on `/readyz`, and the API places no new Episode on a node
below the protocol it sends: the Episode starts on Cloudflare, or is refused with
overflow off, under the placement reason `overflow_node_protocol_too_old`, and the
API logs `node_protocol_too_old` once per node. A live Episode already bound to an
older node is not protected by that guard. So an environment's SFU nodes run the new
build before its API does: deploy the node (`deploy <env> <address>`), check
`/readyz` through the deploy tunnel for the protocol, then release the API. The
managed release deploys the API and Sync only, never the SFU.

## Connect the API

The API reaches a node with its provider-bridge certificate, reissued by
`deploy/certs <env> api <key> <certificate>` so it carries the identity the SFU
requires. Add the service CA to the bridge's two CA bundles, so Sync and the
recorder controllers still verify the reissued certificate, and set:

```sh
CHALK_SFU_ENABLED=true
CHALK_SFU_APPLICATION_ID=chalk-sfu-staging
CHALK_SFU_NODES=sgp1-a=https://203.0.113.10:8443
CHALK_SFU_SERVER_NAME=chalk-sfu
CHALK_SFU_CA_FILE=/run/chalk/provider-bridge/client-ca.crt
CHALK_SFU_CLIENT_CERT_FILE=/run/chalk/provider-bridge/server.crt
CHALK_SFU_CLIENT_KEY_FILE=/run/chalk/provider-bridge/server.key
CHALK_SFU_STUN_URLS=stun:stun.cloudflare.com:3478
```

`CHALK_SFU_CAPTURE_ENABLED` (default `false`) lets the recorder pull from the nodes
through capture sessions. It needs `CHALK_SFU_ENABLED=true`. While it is off, an
Episode bound to `chalk_sfu` refuses to start a Recording. Recording also needs the
recorder fleet: `CHALK_RECORDING_ENABLED=true` and the private provider bridge, because
the API only registers the own-SFU capture provider when it builds the recorder fleet.
Nightly (staging) runs with it on. Keep it off in production until M10 recording parity passes.

`CHALK_SFU_NODES` lists nodes in placement order. A bare `id=url` entry is a primary;
`standby:id=url` marks a standby, which takes a new Episode only when every primary is
silent, draining, host-guard closed or full, and admits at most
`CHALK_SFU_STANDBY_PACKET_BUDGET` packets/s (default 16000) for it. At least one node must be a primary.

`CHALK_SFU_CLOUDFLARE_OVERFLOW` defaults to `true`: a new Episode that no node can
take starts on Cloudflare when its Tenant has a Cloudflare application. Set it to
`false` to refuse that Episode with a retryable `503 media.unavailable` instead.
An Episode already bound to a node never moves either way.

`CHALK_SFU_UNIFIED_SIGNALING` defaults to `true`: the join grant tells the SDK it may send
every SFU signaling call to the one `media/sfu/signal` route, so a join pays one CORS
preflight instead of one per call. Set it to `false` to stop advertising it; SDKs then use
the per-operation routes again on their next join, with no web deploy. The `signal` route
itself stays mounted. Deploy the API before the web build, because an SDK uses the route
only when the grant advertises it.

The switch lets a Space choose `chalk_sfu`, and the allowlist decides which
Spaces may:

```sh
CHALK_SFU_ALLOWED_SPACES=<space id>,<space id>
```

The list holds Space IDs, comma separated. An empty or missing list allows no
Space even when the switch is on, and `*` allows every Space (staging only). An
Episode of a Space outside the list starts on Cloudflare even when the Space or
its Tenant says `chalk_sfu`. Changing the list changes only new Episodes: a live
Episode keeps the provider its binding pinned. Keep the real list in the private
API settings, not in Git. Production keeps the switch off until the M7 canary.

Which plane a new Episode gets is decided in this order, and the first rule that
names one wins:

1. `CHALK_SFU_NEW_EPISODES=off` sends every new Episode to Cloudflare. It is the
   kill switch and defaults to `on`. Live Episodes keep their node.
2. The Space's own setting (`media_plane_setting`), if it has one.
3. The Tenant's `default_media_plane`, when it names a known plane. Before operators
   owned it, any caller could write it with no check, so a value counts only if it
   parses, and `chalk_sfu` counts only if an operator wrote it
   (`tenants.default_media_plane_approved`). The migration leaves every existing row
   unapproved; run `backfill --dry-run` to see how many Tenants hold an unapproved
   `chalk_sfu` or an unknown value (`tenants_with_unapproved_chalk_sfu_default`,
   `tenants_with_unknown_default`), then clear or re-set them with `set --tenant`.
4. `CHALK_DEFAULT_MEDIA_PLANE`.

The guards below the order still apply: a Space outside the allowlist, an SDK that
cannot run the own SFU, and a pool with no room all send the Episode to
Cloudflare, and an Episode that already has a binding keeps it. A Tenant on its own
Cloudflare credentials, or with media disabled, never gets the own SFU, whoever chose
it. If such a Tenant switches after an Episode started, that Episode keeps resolving
from its binding; only the next Episode starts on Cloudflare.

One rule covers a rollback: a stored choice is authoritative only while the legacy
column it was written beside still holds the same value. The previous release does not
read `media_plane_setting` or `default_media_plane_approved`, and it keeps writing
`spaces.media_plane` and `tenants.default_media_plane`. A Space's setting is the
value an operator wrote only while `media_plane` is unchanged; after a rollback and a
redeploy, a `media_plane` the older release wrote is the Space's choice (`chalk_sfu` or
`cf_sfu`; anything else means inherit). A Tenant default is approved only while it
equals the value the operator approved, so a default the older release wrote needs
an operator again. An operator who writes the same value the older release left is
a fresh write. Proof runs name no plane in Create Space: the deployment fills it
(`CHALK_NEW_SPACE_MEDIA_PLANE`), the operator sets the Tenant default, or
`CHALK_CANARY_SPACE_ID` names a Space moved with `media-settings`.

Only an operator sets `chalk_sfu`. The public API refuses it with 403
`space.media_plane_not_permitted` or `tenant.media_plane_not_permitted`, and
accepts `null` (inherit) or the deployment's default plane. The operator command
runs with the API's database and plane settings:

```sh
CHALK_DATABASE_URL=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings get --tenant <id> --space <id>
CHALK_DATABASE_URL=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings set --tenant <id> --space <id> --plane chalk_sfu
CHALK_DATABASE_URL=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings set --tenant <id> --space <id> --plane inherit
CHALK_DATABASE_URL=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings backfill --dry-run
```

Leave out `--space` to act on the Tenant's default. Each change prints one JSON
line with the before and after values, as stored, so an unknown legacy Tenant value
appears as it was. `set --tenant ... --plane inherit` clears such a value.
`backfill` moves Spaces that stored `chalk_sfu` before the setting existed, and are on
the allowlist, onto the setting; a Tenant with its own credentials or with media
disabled is skipped, and the write is conditional, so a Space whose owner pinned
Cloudflare after the listing is left alone. The public API refuses `chalk_sfu` even
where `CHALK_NEW_SPACE_MEDIA_PLANE` hands it to new Spaces.

A setting-only change, such as the backfill, sends no `space.updated` webhook: the
Space's `media_plane` and so its payload do not change. Setting a Space to another
plane changes `media_plane` and does send it.

## Client sunset

An SDK that does not declare `chalk_sfu` in `X-Chalk-Media-Providers` is
Cloudflare-only, and a new Episode in an allowlisted Space starts on Cloudflare
for such a client. `CHALK_SFU_CLIENT_SUNSET` can end that, but no sunset is
planned: Chalk has no outside clients, and the only users, our sister companies,
stay off Chalk until the own SFU is stable. The setting exists and stays unset.

```sh
CHALK_SFU_CLIENT_SUNSET=2027-01-15T00:00:00Z
```

The value is an RFC 3339 instant, and an invalid value stops the API at startup.
Empty or missing means never, which is the default. At and after the instant, a
client that does not declare `chalk_sfu` gets `409 media.client_unsupported` with
the message "This call needs a newer version of Chalk. Update the app and try
again." when it starts an Episode in a Space on the allowlist, the same answer it
already gets when it joins a live Episode on the own SFU. A Space off the
allowlist still starts on Cloudflare. A Tenant with media disabled still starts
Episodes without media. The hosted MCP tools have no SDK to ask, so they count as
capable. A public call is refused before its Space is created. A live Episode
keeps its provider, so a client that cannot run it is refused at join, and a
client joining a Cloudflare Episode is unaffected.

Each refusal logs `event=chalk_sfu.client_refused reason=client_sunset` with no
Tenant or user data, because the request log keeps only the 409 status. Count that
event to see who still runs old builds after the date.

To undo the setting, unset the variable and redeploy. New Episodes of old clients
return to Cloudflare at once.

To check the setting in a non-production deployment, set a past instant and
confirm that the npm release `@q9labsai/chalk-client@5.4.1`, which does not
declare `chalk_sfu`, gets the 409 when it creates an Episode in an allowlisted
Space, and that its `ChalkAPIError.code` is `media.client_unsupported`.

## Run the canary

Move internal Spaces one at a time: add the Space ID to
`CHALK_SFU_ALLOWED_SPACES`, redeploy the API (only while the allowlist exists),
then run `media-settings set --plane chalk_sfu` for that Space. To roll a Space
back, run it with `--plane inherit` (or `cf_sfu`); live Episodes finish on the
node, and new Episodes use Cloudflare. To stop every new own-SFU Episode at once,
set `CHALK_SFU_NEW_EPISODES=off` and restart the API; no setting needs to change,
and removing the variable puts everything back.

The scripted check joins two real SDK clients per trial, measures how long both
take to render audio and video, then blocks UDP to the media provider, proves
that video stopped, restores it, and measures recovery, once with the first
client's microphone on and once muted. Playwright's offline mode does not stop
established WebRTC media, so you give the check the commands that block and
restore the path. Run it once per provider from the same machine, so the two
reports compare:

```sh
export CHALK_CANARY_FAULT_DOWN='sudo iptables -I OUTPUT -p udp -d <media address> -j DROP'
export CHALK_CANARY_FAULT_UP='sudo iptables -D OUTPUT -p udp -d <media address> -j DROP'
CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:canary --joins 20 --faults 10
```

For Cloudflare, use that provider's media address in both commands.

A report passes when every join (including the join of each fault trial) renders within 10 seconds of the second client's join call, every short fault
recovers rendered media within 15 seconds without a manual toggle, and recovery
never turns a muted microphone back on. Set `CHALK_CANARY_SPACE_ID` to reuse one
allowlisted Space instead of creating a Space for each trial.

## Watch the cohort

Every call on a node is a canary call, so the node's metrics are the cohort
view. In Axiom, query the `chalk-prod-metrics` dataset with
`service.name == "chalk-sfu"`:

```text
`chalk-prod-metrics`:`chalk.sfu.sessions` | where `service.name` == "chalk-sfu" | align to 5m using max
`chalk-prod-metrics`:`chalk.sfu.refusals` | where `service.name` == "chalk-sfu" | align to 5m using sum
`chalk-prod-metrics`:`chalk.sfu.pacer.drops` | where `service.name` == "chalk-sfu" | align to 5m using sum
`chalk-prod-metrics`:`chalk.sfu.packet_rate` | where `service.name` == "chalk-sfu" | align to 5m using max
`chalk-prod-metrics`:`chalk.sfu.host.cpu.steal` | where `service.name` == "chalk-sfu" | align to 5m using max
```

Compare `packet_rate` with `packet_budget` for headroom. Any `refusals`, any
sustained `pacer.drops`, or steal above a few percent during a call means the
node is at its limit. The `sfu-readiness` alert in
`infrastructure/observability/production-alerts` watches the node's `/readyz`.

## Bench fleet for multi-node proofs

`features/media/sfu/scripts/bench/bench` makes the two nodes M11 proofs need,
and deletes them the same day: a `s-2vcpu-2gb` primary at packet budget 32000
and a `s-1vcpu-1gb` standby at 16000, about $0.04 an hour together. It uses the
production path (the cloud-init template, `deploy/certs` and `deploy/deploy`
with the `bench` environment), so the nodes run the same image as production.
Run it from a clean checkout, because `deploy` builds the committed revision.

```sh
features/media/sfu/scripts/bench/bench up      # about 5 minutes; prints CHALK_SFU_NODES and the client bundle paths
features/media/sfu/scripts/bench/bench status  # size, age and estimated cost of every tagged Droplet
features/media/sfu/scripts/bench/bench down    # delete the fleet and its firewall, then list the tag
features/media/sfu/scripts/bench/bench reap    # delete bench Droplets older than 3 hours
```

`features/media/sfu/scripts/bench/faults` is the fault harness of M11 package 5.
It runs `up`, then the node-level cases against the real SFU processes: kill the
primary, partition control and heal, return the old node, expire a hold and a
lease, saturate the standby, and drain with a short deadline, a forced
replacement and a drain to zero. It prints a snapshot of both nodes after each
case, deletes the Droplets it created by ID, lists the tag, and exits 1 if a case
failed or a `chalk-sfu-bench-fleet-*` Droplet remains. Droplets of other runs are
listed and left alone. `--long-drain` adds the one-hour drain
(`BENCH_LONG_DRAIN_SECONDS` shortens it for a smoke run). A run takes about 25
minutes and costs a few cents. The cases open sessions and reserves without a
WebRTC peer, so they prove admission, drain and restart behavior and not media
recovery; repair and layer counters reach only the OTLP export.

- Every fleet Droplet carries the tag `chalk-sfu-bench` and lives in `sgp1`.
  `status` and `down` use this tag; `down` deletes only in `sgp1`.
- Control (TCP 8443) and SSH accept only this machine's public IPv4 address.
  `BENCH_CONTROL_ADDRESSES` adds comma-separated IPv4 sources for control, such
  as Instabox. The media port stays open to all, like production.
- Each run issues a fresh CA, server certificate and a one-day client
  certificate with the API identity into `~/.config/chalk-sfu/bench`. `down` deletes the
  directory. Nothing goes to Git or 1Password.
- `up` ends by calling `/readyz` on both nodes over mutual TLS and requires
  the budgets and two different node incarnations. If any step fails, it deletes
  the fleet before it exits.
- `down` deletes the fleet's own Droplets (`chalk-sfu-bench-fleet-*`), waits
  until they are gone, then removes the firewall and the certificates and lists
  the tag. It exits 1 if one of them remains. Another run that also wears the
  tag, such as a load generator, is left alone and reported with exit 3.
  `down --all` deletes every tagged Droplet in `sgp1`.
- `reap [hours]` (default 3) deletes Droplets older than the age with a name
  starting `chalk-sfu-bench` **or** the tag `chalk-sfu-bench`, in any region.
  This includes legacy rollout load generators with missing or different tags.
  Names starting `chalk-sfu-staging` or `chalk-sfu-production` are never selected,
  even if accidentally bench-tagged. Other names without the bench tag are untouched. Skip
  one with `--exclude <droplet id>`, repeated as needed, and list the targets
  first with `--dry-run`. It uses DigitalOcean's creation time, so it works from
  any machine, and it removes the firewall and certificates only after the
  Droplets are gone.

The [SFU bench reaper workflow](../../.github/workflows/sfu-bench-reaper.yml)
runs `bench reap 4` hourly at minute 23 UTC and supports manual dispatch on
`master`. It uses the existing `nightly` Environment's `DIGITALOCEAN_ACCESS_TOKEN`,
as the managed deploy workflow does, and the same `ubuntu-24.04` hosted runners
as other scheduled workflows. Runs do not overlap. Deletions log the name and ID;
DigitalOcean list, delete or deletion-poll errors fail the job.

For a longer soak, add a tag `keep-until-<unix-seconds>` to the Droplet, where the
suffix is the UTC Unix expiry in whole seconds (for example `keep-until-1794153600`).
The reaper skips it only while at least one well-formed expiry is in the future.
Expired or malformed keep tags do not prevent deletion once the Droplet is old
enough. Remove or extend the tag as needed; it never grants a permanent exemption.
`--exclude` applies only to that invocation, not the scheduled run. Preview with:

```sh
features/media/sfu/scripts/bench/bench reap 4 --dry-run
```

A stopped Droplet still bills, so never power one off to save money: delete it.
