# Own-SFU nodes

This root applies the [SFU node module](node) once per environment, staging and production, each with its own state. Real addresses, state settings and certificates stay outside Git, in `~/.config/chalk-sfu/<env>` and 1Password.

## Build or rebuild a node

1. Copy `backend.hcl.example` and `node.tfvars.example` to the private directory and fill them in. `control_addresses` lists the API host's public addresses, the only ones that may reach the control port.
2. Apply with a separate data directory per environment, then save the node's address as `address` in the private directory:

   ```sh
   export TF_DATA_DIR=~/.config/chalk-sfu/staging/.terraform DIGITALOCEAN_TOKEN="$(doctl auth token)"
   tofu -chdir=infrastructure/sfu init -backend-config=$HOME/.config/chalk-sfu/staging/backend.hcl
   tofu -chdir=infrastructure/sfu apply -var-file=$HOME/.config/chalk-sfu/staging/node.tfvars
   tofu -chdir=infrastructure/sfu output -raw public_ip
   ```

3. Issue certificates once per environment (`certs staging ca`, then `certs staging server`), then deploy:

   ```sh
   SFU_SSH_KEY=~/.ssh/chalk-sfu-operator_ed25519 infrastructure/sfu/deploy staging "$(cat ~/.config/chalk-sfu/staging/address)"
   ```

To change `control_addresses` or `ssh_addresses`, widen first and narrow second. The cloud firewall and the node's own firewall both filter SSH, and only a deploy run brings the node's firewall into line, so a straight swap locks out both: the cloud firewall drops the old address while the node's firewall still drops the new one, and no run can reach the node to fix it.

1. Apply with the old and the new addresses both listed, then run `deploy <env> <address> --firewall-only` (it changes no running calls).
2. Check the node is reachable from the new address (SSH, and the API's control calls for `control_addresses`).
3. Apply with the old address removed, then run `--firewall-only` again.

To replace a broken node, taint the Droplet, apply, update `CHALK_SFU_NODES` in the API's settings if the address changed, and deploy. The node ID the API records stays the same, so bound Episodes still name it.

## Upgrade order

The SFU decodes requests strictly, so a field the API adds is refused as `400 invalid_request` by a node that predates it. Each node reports its wire protocol and build commit on `/readyz`, and the API places no new Episode on a node below the protocol it sends (the Episode starts on Cloudflare, or is refused with overflow off, with placement reason `overflow_node_protocol_too_old`). A live Episode already bound to an older node is not protected by that guard. So an environment's SFU nodes run the new build before its API does: deploy the node, check `/readyz` through the deploy tunnel for the protocol, then release the API. The managed release deploys the API and Sync only, never the SFU.

## Connect the API

The API reaches a node with its provider-bridge certificate, reissued by `certs <env> api <key> <certificate>` so it carries the identity the SFU requires. Add the service CA to the bridge's two CA bundles, so Sync and the recorder controllers still verify the reissued certificate. The `CHALK_SFU_*` settings (listed in `apps/api/internal/config/config.go`, with examples in `infrastructure/managed-episode/env/api.env.example`) then enable it.

- `CHALK_SFU_NODES` lists nodes in placement order. A bare `id=url` is a primary; `standby:id=url` takes a new Episode only when every primary is silent, draining, host-guard closed or full, and is held to `CHALK_SFU_STANDBY_PACKET_BUDGET`. At least one node must be a primary.
- `CHALK_SFU_CAPTURE_ENABLED` lets the recorder pull from nodes through capture sessions and needs `CHALK_SFU_ENABLED=true`. While off, an Episode bound to `chalk_sfu` refuses to start a Recording. It also needs the recorder fleet (`CHALK_RECORDING_ENABLED=true` and the private provider bridge), because the API registers the own-SFU capture provider only when it builds the fleet. Nightly runs with it on; keep it off in production until M10 recording parity passes.
- `CHALK_SFU_COLOCATED_CAPTURE` (default `false`; needs `CHALK_SFU_CAPTURE_ENABLED=true`) makes the API register one capture worker per node in `CHALK_SFU_NODES` and prefer it for the captures of that node's Episodes. `CHALK_SFU_COLOCATED_CAPTURE_GRACE_SECONDS` (default 20) is how long a capture waits for the healthy worker of its node before the on-demand fleet may take it, so an unhealthy or full worker costs a delay and never a recording. Off is the default and leaves every capture to the fleet. The worker itself is deployed by `features/media/sfu/deploy/deploy`.
- `CHALK_SFU_CLOUDFLARE_OVERFLOW` (default `true`) starts a new Episode that no node can take on Cloudflare when its Tenant has a Cloudflare application. `false` refuses it with a retryable `503 media.unavailable`. An Episode already bound to a node never moves either way.
- `CHALK_SFU_UNIFIED_SIGNALING` (default `true`) lets the join grant tell the SDK to send all SFU signaling to one route, so a join pays one CORS preflight. Setting `false` makes SDKs use per-operation routes on their next join, with no web deploy. Deploy the API before the web build, because an SDK uses the route only when the grant advertises it.
- `CHALK_SFU_ALLOWED_SPACES` is a comma-separated list of Space IDs allowed to use `chalk_sfu`. Empty or missing allows none even with the switch on; `*` allows every Space (staging only). A Space outside the list starts on Cloudflare even if its Space or Tenant says `chalk_sfu`. Changing it affects only new Episodes. Keep the real list in the private API settings. Production keeps the switch off until the M7 canary.

## Which plane a new Episode gets

The first rule that names a plane wins:

1. The kill switch sends every new Episode to Cloudflare, and live Episodes keep their node. It is stored in the database, so `media-settings new-episodes --state off --operator <name> --reason <text>` takes effect on the next new Episode with no API restart, and `--state on` puts it back. Every flip writes an audit row (who, why, before, after). Without `--state` the command shows the live value. `CHALK_SFU_NEW_EPISODES=off` is a deploy-time floor under it: while the variable says off, the switch is off whatever the database says.
2. The Space's own setting (`media_plane_setting`), if it has one.
3. The Tenant's `default_media_plane`, when it names a known plane. Before operators owned it any caller could write it unchecked, so a value counts only if it parses, and `chalk_sfu` counts only if an operator wrote it (`tenants.default_media_plane_approved`). The migration left every existing row unapproved; `media-settings backfill --dry-run` reports how many Tenants hold an unapproved `chalk_sfu` or an unknown value, and `set --tenant` clears or re-sets them.
4. `CHALK_DEFAULT_MEDIA_PLANE`.

The guards still apply after that: a Space outside the allowlist, an SDK that cannot run the own SFU, and a pool with no room all send the Episode to Cloudflare, and an Episode that already has a binding keeps it. A Tenant on its own Cloudflare credentials, or with media disabled, never gets the own SFU, whoever chose it.

**Rollback rule.** The previous release does not read `media_plane_setting` or `default_media_plane_approved`, and keeps writing `spaces.media_plane` and `tenants.default_media_plane`. So a stored choice is authoritative only while the legacy column written beside it still holds the same value. After a rollback and redeploy, a `media_plane` the older release wrote is the Space's choice. A Tenant default is approved only by the operator command: a trigger clears the approval whenever the default changes and refuses any other write of the flag unless the transaction sets `chalk.operator_write` (only `media-settings` does), so no sequence of writes from the API or the older release can create or restore an approval.

Only an operator sets `chalk_sfu`. The public API refuses it with 403 `space.media_plane_not_permitted` or `tenant.media_plane_not_permitted` and accepts `null` (inherit) or the deployment's default plane. Proof runs name no plane in Create Space: the deployment fills it (`CHALK_NEW_SPACE_MEDIA_PLANE`), the operator sets the Tenant default, or `CHALK_CANARY_SPACE_ID` names a Space moved with `media-settings`. A proof that runs both planes (`prod:latency`) takes `CHALK_PROOF_SPACE_ID_<PLANE>` for each moved Space and stops at once when a Space is not on the plane it asked for.

The operator command runs from `apps/api` with the API's own database and plane settings (without `CHALK_DEFAULT_MEDIA_PLANE`, `--plane inherit` is refused):

```sh
CHALK_DATABASE_URL=… CHALK_DEFAULT_MEDIA_PLANE=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings get --tenant <id> --space <id>
CHALK_DATABASE_URL=… CHALK_DEFAULT_MEDIA_PLANE=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings set --tenant <id> --space <id> --plane chalk_sfu
CHALK_DATABASE_URL=… CHALK_DEFAULT_MEDIA_PLANE=… CHALK_SFU_ALLOWED_SPACES=… go run ./cmd/media-settings backfill --dry-run
```

Leave out `--space` to act on the Tenant's default. Each change prints one JSON line with the stored before and after values. `backfill` moves Spaces that stored `chalk_sfu` before the setting existed, and are on the allowlist, onto the setting; Tenants with their own credentials or media disabled are skipped, and the write is conditional so a Space whose owner pinned Cloudflare after the listing is left alone. A setting-only change sends no `space.updated` webhook, because the Space's `media_plane` payload does not change.

### Send one Space back to Cloudflare, and return it

The Space setting is the kill switch for one Space. It moves the Space's next Episodes to Cloudflare (`cf_sfu`) and back with no deploy and no API reload. To stop every new Episode instead, run `media-settings new-episodes --state off --operator <name> --reason <text>`; it needs no reload. Use the Space setting first.

**Who runs it.** A Chalk operator holding the API's database and plane settings, because `media-settings` is the only way to set `chalk_sfu` and the API has no operator principal. A Tenant owner with the Tenant API key can do the one-way half with `PATCH /v1/tenants/{tenant_id}/spaces/{space_id}` and `{"media_plane":"cf_sfu"}`, but the return always goes through an operator.

**The rule that shapes the steps.** The flip changes only Episodes that start after it. An Episode keeps the plane its binding pinned, so guests who reload and rejoin a live Episode land on the same plane. Moving a live call means ending the Episode and starting a new one.

1. Run `get` and confirm the IDs. `effective_plane` is what the next Episode gets; `kill_switch_on` and `on_allowlist` explain it when it is not what you expect.
2. Run `set ... --plane cf_sfu` and keep the printed `before`/`after` line in the incident log beside your name, since it records the Space and planes, not the operator. Use `cf_sfu`, not `inherit`, because `inherit` hands the choice to the Tenant and deployment defaults, which may be `chalk_sfu`.
3. If a call is live and must move, end its Episode through the owner API (`POST /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end`) or the host's End button, then start a new one. Guests in the ended Episode see the call end (`left` with `episodeEnded: true`); a guest who opens the invite link joins the new Episode on Cloudflare. With no live call, skip this step.
4. Verify: `get` shows `cf_sfu`, and a new Episode's join grant reports `media.provider` as `cloudflare_sfu` with audio and video. `media-provider-inventory` counts live Episodes by provider.
5. To return, run `set ... --plane chalk_sfu` and repeat step 3. The new Episode binds the own SFU only when the Space is on the allowlist, the SDK declares `chalk_sfu` and a node has room; otherwise it starts on Cloudflare (overflow on) or the create fails. Treat the return as done when the new join grant reports `media.provider` as `chalk_sfu`, not when `get` says so.

## Client sunset

An SDK that does not declare `chalk_sfu` in `X-Chalk-Media-Providers` is Cloudflare-only, so a new Episode in an allowlisted Space starts on Cloudflare for it. `CHALK_SFU_CLIENT_SUNSET` (an RFC 3339 instant; invalid stops the API at startup) can end that by answering `409 media.client_unsupported` from that instant, but no sunset is planned: Chalk has no outside clients, and the only users, our sister companies, stay off Chalk until the own SFU is stable. The setting exists and stays unset. Hosted MCP tools count as capable; a Space off the allowlist and a Tenant with media disabled are unaffected, and a live Episode keeps its provider. Each refusal logs `event=chalk_sfu.client_refused reason=client_sunset`, which is how to count who still runs old builds. To undo, unset the variable and redeploy.

## Run the canary

Move internal Spaces one at a time: add the Space ID to `CHALK_SFU_ALLOWED_SPACES`, redeploy the API, then run `media-settings set --plane chalk_sfu` for that Space. To roll a Space back run it with `--plane inherit` (or `cf_sfu`); live Episodes finish on the node and new Episodes use Cloudflare. To stop every new own-SFU Episode at once, run `media-settings new-episodes --state off --operator <name> --reason <text>`; no setting needs to change, and `--state on` puts everything back.

`pnpm prod:canary` joins two real SDK clients per trial, measures time to render audio and video, blocks UDP to the media provider, proves video stopped, restores it and measures recovery, once with the first client's microphone on and once muted. Playwright's offline mode does not stop established WebRTC media, so you supply the commands that block and restore the path. Run it once per provider from the same machine so the reports compare, using that provider's media address:

```sh
export CHALK_CANARY_FAULT_DOWN='sudo iptables -I OUTPUT -p udp -d <media address> -j DROP'
export CHALK_CANARY_FAULT_UP='sudo iptables -D OUTPUT -p udp -d <media address> -j DROP'
CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:canary --joins 20 --faults 10
```

A report passes when every join renders within 10 seconds of the second client's join call, every short fault recovers rendered media within 15 seconds without a manual toggle, and recovery never turns a muted microphone back on. `CHALK_CANARY_SPACE_ID` reuses one allowlisted Space.

## Watch the cohort

Every call on a node is a canary call, so the node's metrics are the cohort view. In Axiom, query `chalk-prod-metrics` with `service.name == "chalk-sfu"` for `chalk.sfu.sessions`, `chalk.sfu.refusals`, `chalk.sfu.pacer.drops`, `chalk.sfu.packet_rate` and `chalk.sfu.host.cpu.steal`. Compare `packet_rate` with `packet_budget` for headroom. Any `refusals`, any sustained `pacer.drops`, or steal above a few percent during a call means the node is at its limit. The `sfu-readiness` alert in `infrastructure/observability/production-alerts` watches `/readyz`.

## Bench fleet for multi-node proofs

`features/media/sfu/scripts/bench/bench up|status|down|reap` makes the two nodes the multi-node proofs need and deletes them the same day (a `s-2vcpu-2gb` primary and a `s-1vcpu-1gb` standby, about $0.04 an hour together). It uses the production path (cloud-init template, `deploy/certs`, `deploy/deploy` with the `bench` environment), so the nodes run the production image. Run it from a clean checkout, because `deploy` builds the committed revision. `features/media/sfu/scripts/bench/faults` runs the node-level fault cases against the real SFU processes (about 25 minutes, a few cents). Its cases open sessions and reserves without a WebRTC peer, so they prove admission, drain and restart behavior, not media recovery. The script headers document the commands and flags.

- Every fleet Droplet carries the tag `chalk-sfu-bench` in `sgp1`. Control (TCP, the port in `features/media/sfu/internal/config/node.json`) and SSH accept only this machine's public IPv4 address (`BENCH_CONTROL_ADDRESSES` adds sources); the media port stays open like production.
- Each run issues a fresh CA, server certificate and one-day client certificate into `~/.config/chalk-sfu/bench`, and `down` deletes the directory. Nothing goes to Git or 1Password.
- `up` deletes the fleet itself if any step fails. `down` exits 1 if a fleet Droplet remains; a foreign Droplet wearing the tag is left alone and reported with exit 3.
- `reap [hours]` (default 3) deletes Droplets older than the age whose name starts `chalk-sfu-bench` **or** that carry the tag, in any region, including legacy load generators. Names starting `chalk-sfu-staging` or `chalk-sfu-production` are never selected. Use `--dry-run` first and `--exclude <droplet id>` to skip one.

The [SFU bench reaper workflow](../../.github/workflows/sfu-bench-reaper.yml) runs `bench reap 4` hourly and on manual dispatch, using the `nightly` Environment's `DIGITALOCEAN_ACCESS_TOKEN`. For a longer soak, tag the Droplet `keep-until-<unix-seconds>`; the reaper skips it only while a well-formed expiry is in the future, so the tag never grants a permanent exemption. A stopped Droplet still bills, so never power one off to save money: delete it.

## Deploy script

- `certs <staging|production> <ca|server|api|operator>` issues certificates from the environment's service CA. The CA key lives in 1Password and issued files go to `~/.config/chalk-sfu/<env>`, never into Git. The API certificate carries `spiffe://chalkmeet.com/environment/<env>/api` with client auth. Rotate by issuing again and redeploying.
- Metrics export needs `~/.config/chalk-sfu/<env>/otlp-headers` holding the `OTEL_EXPORTER_OTLP_METRICS_HEADERS` value (an ingest-only token, kept in 1Password). Deploy installs it as the Podman secret `chalk-sfu-otlp-headers`. Without the file, deploy warns and the node exports nothing.
- Log export needs `~/.config/chalk-sfu/<env>/otlp-log-headers`, holding the `OTEL_EXPORTER_OTLP_LOGS_HEADERS` value for the API's log dataset, in the same form as `otlp-headers`. Deploy installs it as the Podman secret `chalk-sfu-otlp-log-headers`. Without the file, deploy warns and the node logs to the journal only.
- `deploy <staging|production> <node address> [--force|--firewall-only]` aligns the node's ufw with its cloud firewall, builds the image at the current commit, installs certificates as Podman secrets, renders settings for the node's size (packet budget, steal limit, `GOMEMLIMIT` and container memory by node size; the table is `features/media/sfu/internal/config/node.json`, with its reasoning in [capacity calibration](../../docs/sfu/capacity-calibration.md)), drains the running node until it reports zero `allocations` and `cleanupDebt`, restarts it and checks `/readyz` through an SSH tunnel. If `SFU_DRAIN_TIMEOUT` (default 3600 seconds) ends first, deploy undrains and exits, because a restart then would cut live calls; `--force` accepts that. It fails when the granted receive buffer is below 8 MiB. Running it twice converges.
- A node running a build from before #951 counts standing source leases as allocations, so its drain never reaches zero. Run `deploy <environment> <node address> --force` once, when no live call needs the node. To undo, redeploy the previous image with `--force`.
