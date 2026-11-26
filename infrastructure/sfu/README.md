# Chalk SFU nodes

This root applies the [SFU node module](node) once per environment, staging and production, each with its own state. Real addresses, state settings and certificates stay outside Git, in `~/.config/chalk-sfu/<env>` and 1Password.

## Alchemy owns production

Alchemy owns the production `sfu` and `sfu-standby` stacks (`alchemy.run.ts`,
selected with `CHALK_SFU_STACK`). Plan and deploy them with their private inputs
file, described in the [migration reference](../migration/digitalocean.md):

```sh
AWS_PROFILE=q9labs DIGITALOCEAN_TOKEN="$(doctl auth token)" CHALK_INFRA_INPUTS=$HOME/.config/chalk-sfu/production/sfu-inputs.json pnpm infra plan sfu production
AWS_PROFILE=q9labs DIGITALOCEAN_TOKEN="$(doctl auth token)" CHALK_INFRA_INPUTS=$HOME/.config/chalk-sfu/production/sfu-inputs.json pnpm infra deploy sfu production
```

A deploy never replaces or reboots a node: the provider ignores cloud-init and
image changes after creation and refuses region, monitoring and IPv6 changes and
unplanned resizes. It changes the cloud firewall in place. The stack output holds
the node's `name`, `public_ip` and `droplet_id`.

The OpenTofu root below stays as the rollback path until one more clean Alchemy
production release has run. Don't apply it to production meanwhile: it would
undo firewall changes Alchemy made. The cloud-init renderer is checked
byte-for-byte against its OpenTofu rendering.

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

The SFU decodes requests strictly, so a field the API adds is refused as `400 invalid_request` by a node that predates it. Each node reports its wire protocol and build commit on `/readyz`, and the API places no new Episode on a node below the protocol it sends (the Episode starts on Cloudflare, or is refused with overflow off, with placement reason `overflow_node_protocol_too_old`). A live Episode already bound to an older node is not protected by that guard. So an environment's SFU nodes must run the new build before its API does.

Production does this inside the managed release, so nobody upgrades a node by hand:

1. Promote's `sfu-nodes` job reads each node's `/readyz` and compares the node's `revision` with the release's SFU source (`features/media/sfu`, the last commit that touched it). A node is current when that source commit is an ancestor of, or equal to, its revision, and its protocol meets the API's `minNodeProtocol`. The job prints which nodes are behind and fails Promote, before the approval-gated work starts, when a node cannot be read or the operator certificate is close to expiry, so a broken route is found before the release rather than during it. A behind node is not a failure here, because the next step upgrades it.
2. The `Release` run (`.github/workflows/ci.yml`, job `deploy-managed`) then runs `scripts/releases/sfu_nodes.py deploy` before the API and Sync deploy. It runs `deploy production <address>` for each behind node, in the order of `nodes`, builds the image from the release SHA's SFU source, drains the node, restarts it, and checks `/readyz`. It re-reads `/readyz` afterwards and fails the run, before the API, when a node is still behind or not ready. A node that is already current is not touched, so a release that changes no SFU source restarts nothing.
3. Promote refuses to start with live calls on the platform (the `live-calls` job), so the drain finds the node empty. `allow_live_calls` and every rollback and Hotfix pass `--force`, which restarts without waiting for the drain, because a Hotfix or rollback is already an emergency.
4. Hotfix and both rollbacks use the same job. Nodes only move forward: an older API places on a newer node by the protocol's backward-compatibility rule, so a rollback tries to bring the node to the rolled-back SHA's source. Every Hotfix and rollback, including the backend-only one `hotfix.py rollback-command` prints, passes `sfu_best_effort`, so a node failure there is reported and never stops the API and Sync restore.

**How CI reaches a node.** The node's SSH port is open to the world with key-only login, the control port stays closed except to the API's address, and GitHub runners have no fixed address. So CI does what an operator does: SSH to the node and tunnel to the control port, with the node's host keys pinned in `known_hosts` and `StrictHostKeyChecking=yes`. This needs no firewall change, no DigitalOcean write token and no new cost. A release run never reconciles control or SSH firewall rules and never touches the capture worker beside a node (`SFU_FROM_CI`); it still reconciles the target source’s media TCP ports because existing nodes cannot learn them from ignored user_data: the bundle holds no capture CA key, so capture stays as the last operator run left it, and only an operator run changes it. The log names nodes by their position in `nodes` and masks their addresses.

**The secret.** Everything the deploy reads from `~/.config/chalk-sfu/production` (CA and server certificates, the server key, a 90-day operator certificate and key, `known_hosts`, `nodes`, the SSH key and the OTLP headers) is one GitHub secret, `CHALK_SFU_DEPLOY_BUNDLE`, in the `production` environment. The CA key never leaves 1Password. Publish or refresh it from the operator's machine:

```sh
infrastructure/sfu/ci-secret publish production
```

The operator certificate lives 90 days. Promote's preflight and the deploy step fail with that command when it has fewer than 3 days left (the server certificate, 14). Run it again after any change to `nodes`, a node's host key, the SSH key or the OTLP headers.

**Read a node.** `infrastructure/sfu/readyz <env> <address>` prints a node's `/readyz` through the tunnel, which is the same check the release makes.

**Protocol bumps.** The Gate for the SFU (`features/media/sfu/scripts/check_wire_protocol.py`) refuses a change that edits the node's Go source and the API's Chalk SFU adapter or the SDK's media client together, unless it raises `WireProtocol` and the API's `minNodeProtocol` together or a commit message says `Wire-Protocol: unchanged because <reason>`. It catches the two sides changing together without a decision, as #1514 did. It does not catch a behavior change made on one side alone, and it cannot judge whether a stated reason is right. The release covers those cases by deploying the node before the API whenever its source changed.

Staging and bench nodes are still deployed by hand with `deploy <env> <address>`, before the staging API.

## Connect the API

The API reaches a node with its provider-bridge certificate, reissued by `certs <env> api <key> <certificate>` so it carries the identity the SFU requires. Add the service CA to the bridge's two CA bundles, so Sync and the recorder controllers still verify the reissued certificate. The `CHALK_SFU_*` settings (listed in `apps/api/internal/config/config.go`, with examples in `infrastructure/managed-episode/env/api.env.example`) then enable it.

- `CHALK_SFU_NODES` lists nodes in placement order. A bare `id=url` is a primary; `standby:id=url` takes a new Episode only when every primary is silent, draining, host-guard closed or full, and is held to `CHALK_SFU_STANDBY_PACKET_BUDGET`. At least one node must be a primary.
- `CHALK_SFU_CAPTURE_ENABLED` lets the recorder pull from nodes through capture sessions and needs `CHALK_SFU_ENABLED=true`. While off, an Episode bound to `chalk_sfu` refuses to start a Recording. It also needs the recorder fleet (`CHALK_RECORDING_ENABLED=true` and the private provider bridge), because the API registers the Chalk SFU capture provider only when it builds the fleet. Nightly runs with it on; keep it off in production until M10 recording parity passes.
- `CHALK_SFU_COLOCATED_CAPTURE` (default `false`; needs `CHALK_SFU_CAPTURE_ENABLED=true`) makes the API register one capture worker per node in `CHALK_SFU_NODES` and prefer it for the captures of that node's Episodes. `CHALK_SFU_COLOCATED_CAPTURE_GRACE_SECONDS` (default 20) is how long a capture waits for the healthy worker of its node before the on-demand fleet may take it, so an unhealthy or full worker costs a delay and never a recording. Off is the default and leaves every capture to the fleet. The worker itself is deployed by `features/media/sfu/deploy/deploy`.

## Pausing new Episodes

`media-settings new-episodes --state off --operator <name> --reason <text>`
stops new Episodes without interrupting live ones. Use `--state on` to resume.
`CHALK_SFU_NEW_EPISODES=off` also pauses them until the deploy-time setting changes.

## Run the canary

`pnpm prod:canary` joins two real SDK clients per trial, measures time to render audio and video, blocks UDP to the media provider, proves video stopped, restores it and measures recovery, once with the first client's microphone on and once muted. Playwright's offline mode does not stop established WebRTC media, so you supply the commands that block and restore the path. Use the Chalk SFU media address:

```sh
export CHALK_CANARY_FAULT_DOWN='sudo iptables -I OUTPUT -p udp -d <media address> -j DROP'
export CHALK_CANARY_FAULT_UP='sudo iptables -D OUTPUT -p udp -d <media address> -j DROP'
CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:canary --joins 20 --faults 10
```

A report passes when every join renders within 10 seconds of the second client's join call, every short fault recovers rendered media within 15 seconds without a manual toggle, and recovery never turns a muted microphone back on. `CHALK_CANARY_SPACE_ID` reuses one Space.

## Watch the cohort

Every call on a node is a canary call, so the node's metrics are the cohort view. In Axiom, query `chalk-prod-metrics` with `service.name == "chalk-sfu"` for `chalk.sfu.sessions`, `chalk.sfu.refusals`, `chalk.sfu.pacer.drops`, `chalk.sfu.packet_rate` and `chalk.sfu.host.cpu.steal`. Compare `packet_rate` with `packet_budget` for headroom. Any `refusals`, any sustained `pacer.drops`, or steal above a few percent during a call means the node is at its limit. The `sfu-readiness` alert in `infrastructure/observability/production-alerts` watches `/readyz`.

## Bench fleet for multi-node proofs

`features/media/sfu/scripts/bench/bench up|status|down|reap` makes the two nodes the multi-node proofs need and deletes them the same day (a `s-2vcpu-2gb` primary and a `s-1vcpu-1gb` standby, about $0.04 an hour together). It uses the production path (cloud-init template, `deploy/certs`, `deploy/deploy` with the `bench` environment), so the nodes run the production image. Run it from a clean checkout, because `deploy` builds the committed revision. `features/media/sfu/scripts/bench/faults` runs the node-level fault cases against the real SFU processes (about 25 minutes, a few cents). Its cases open sessions and reserves without a WebRTC peer, so they prove admission, drain and restart behavior, not media recovery. The script headers document the commands and flags.

- Every fleet Droplet carries the tag `chalk-sfu-bench` in `sgp1`. Control (TCP, the port in `features/media/sfu/internal/config/node.json`) and SSH accept only this machine's public IPv4 address (`BENCH_CONTROL_ADDRESSES` adds sources); the media port stays open like production.
- Each run issues a fresh CA, server certificate and one-day client certificate into `~/.config/chalk-sfu/bench`, and `down` deletes the directory. Nothing goes to Git or 1Password.
- `up` deletes the fleet itself if any step fails. `down` exits 1 if a fleet Droplet remains; a foreign Droplet wearing the tag is left alone and reported with exit 3.
- `reap [hours]` (default 3) deletes Droplets older than the age whose name starts `chalk-sfu-bench` **or** that carry the tag, in any region, including legacy load generators. Names starting `chalk-sfu-staging` or `chalk-sfu-production` are never selected. Use `--dry-run` first and `--exclude <droplet id>` to skip one.

The [SFU bench reaper workflow](../../.github/workflows/sfu-bench-reaper.yml) runs `bench reap 4` hourly and on manual dispatch, using the `nightly` Environment's `DIGITALOCEAN_ACCESS_TOKEN`. For a longer soak, tag the Droplet `keep-until-<unix-seconds>`; the reaper skips it only while a well-formed expiry is in the future, so the tag never grants a permanent exemption. A stopped Droplet still bills, so never power one off to save money: delete it.

## Window node snapshot

A window node is a Chalk SFU that exists only around a scheduled class. The runtime controller creates it from a DigitalOcean snapshot ID and never deploys to it, never opens SSH to it and never trusts a host key on first use. `window-image` makes that snapshot. Publishing one is an explicit operator action and changes no running node: the snapshot becomes the fleet's image only when its ID goes into the controller's settings.

**What a clone does.** The snapshot holds the production bootstrap (rootless Podman, the 8 MiB buffers, the host firewall), the SFU image built at the pinned commit, the environment's window server certificate and key as the same Podman secrets `deploy` installs, and two templates. At every boot `chalk-sfu-window.service` runs `window-boot`, which reads the Droplet's own public IPv4 from the metadata service (a link-local address that returns no secret), accepts only a globally routable unicast address and retries for two minutes, then picks the measured node size from the vCPU count, renders `sfu.env` (`SFU_ANNOUNCE_IPS` is the detected address) and the Quadlet unit from the same templates `deploy` uses, and starts the node. If no usable address appears the node stays down, because a node that announced a wrong address would look healthy and fail every call. The image itself carries no address. It is built on and for the 2 vCPU `s-2vcpu-2gb` size (disk 60 GB, so a clone needs at least that disk); the settings come from `features/media/sfu/internal/config/node.json` at boot.

**What the snapshot does not hold.** No SSH key, no SSH host key, no operator client certificate, no metrics, log or trace token and no cloud token. SSH is masked and absent from the host firewall, so a clone has no way in; debug a bad one from the DigitalOcean console or rebuild it. The user data a controller sends carries no secret either: the image needs none, so it can send an empty one. The capture worker is not shipped (the image has no `capture.conf`), so captures use the existing fallback to the on-demand recorder fleet. Metrics and log export are off for the same reason: the ingest tokens are secrets, so a window node logs to its journal only and does not feed the `sfu-readiness` alert or the cohort view.

**The one secret in it.** The server key lives in the snapshot, in the rootless Podman secret store of `chalk-sfu`, like on a static node. It is a key of its own, `certs <env> window-server`, so a leaked snapshot exposes a window-only identity and never a static node's. It still lets its holder pose as an SFU to the API, and the CA has no revocation, so keep snapshot and Droplet-create rights to the people who already hold the DigitalOcean token, and replace a compromised key by issuing a new certificate and rebuilding. The certificate lives 180 days and the build refuses one with fewer than 90 left, so an image is good for at least 90 days; rebuild before then.

**Publish an image.** From a clean checkout at the commit to pin, on the operator's machine (Docker, `doctl`, `jq`, SSH key `~/.ssh/chalk-sfu-operator_ed25519` and the `chalk-sfu-operator` DigitalOcean key as for `deploy`):

```sh
infrastructure/sfu/certs staging window-server
infrastructure/sfu/window-image build staging --revision "$(git rev-parse HEAD)" --control-addresses 192.0.2.10/32 --region sgp1
infrastructure/sfu/window-image verify staging <snapshot id> --region sgp1
```

`--control-addresses` lists the API host's public addresses, the only sources the clone's host firewall lets reach the control port (the cloud firewall the controller attaches must allow the same). The revision must be the checkout's `HEAD`, clean, and on `origin/master`. `build`:

1. checks the certificate (verifies against the environment CA, names `chalk-sfu`, matches its key, 90 days left) before any cloud call, then builds the SFU image at the revision;
2. creates a builder from `ubuntu-24-04-x64` with the production cloud-init, SSH allowed from this machine's address only, and a throwaway SSH host key in its user data, so the first connection is checked against a key the script knows (the one place a key sits in user data; it leaves with the builder);
3. loads the image and the certificate secrets, installs the templates, `window-boot` and its unit, then starts the node through that same unit and checks that it announces the builder's own address and answers `/readyz` with the pinned revision, the measured packet budget and 8 MiB buffers;
4. seals the builder (`window-seal`): removes SSH keys, host keys and the SSH rule, masks SSH, resets cloud-init and the machine ID, clears logs and the builder's network config, then fails if any key, token, operator file or the builder's address is left anywhere;
5. powers it off, snapshots it as `chalk-sfu-window-<env>-<sha12>-<time>`, writes `~/.config/chalk-sfu/<env>/window-image-<snapshot id>.json` and deletes the builder (`--keep-builder` keeps it for inspection and says how to delete it). A failed build deletes its builder too; `doctl compute droplet list --tag-name chalk-sfu-window-builder` finds a stray one.

`verify` is the cold boot receipt. It creates a clone from the snapshot with a firewall that admits only this machine, uses no user data, and waits for `/readyz` with the environment's certificate, and checks the revision, no calls, 8 MiB buffers, both media TCP ports open and SSH closed, then deletes the clone and the firewall. Run it from a source already covered by the snapshot’s control addresses; the probe does not modify the host firewall. A snapshot is not ready for the controller until `verify` has passed for it. Releasing it is putting its ID in the controller's settings; to roll back, put the previous ID back, and delete a bad snapshot with `doctl compute snapshot delete <id>`. A build and a verify cost a few cents each. To use a snapshot in another region, transfer it first (`doctl compute image-action transfer`).

**What is not proved.** Everything above runs against mocked `doctl`, `ssh` and `docker` in `test_window_image.py`, which also checks that the templates render to the same settings `deploy` writes and that the new certificate verifies. Nothing has run against DigitalOcean. The assumptions only a real run settles: that cloud-init installs the pinned host key before `ssh` is first offered (the script keeps retrying a mismatch and then fails), that `cloud-init clean --machine-id` and a new Droplet id make a clone run cloud-init again, that the seal's leftover scan finds nothing from DigitalOcean's own agents, and that `verify`'s port checks behave through a real cloud firewall. `verify` cannot see the announced address (`/readyz` does not show it); the build proves the boot path announces the builder's own address, and the first call through a clone (the canary) proves it for clones.

## Deploy script

- `certs <staging|production> <ca|server|window-server|api|operator>` issues certificates from the environment's service CA. The CA key lives in 1Password and issued files go to `~/.config/chalk-sfu/<env>`, never into Git. The API certificate carries `spiffe://chalkmeet.com/environment/<env>/api` with client auth. Rotate by issuing again and redeploying.
- Metrics export needs `~/.config/chalk-sfu/<env>/otlp-headers` holding the `OTEL_EXPORTER_OTLP_METRICS_HEADERS` value (an ingest-only token, kept in 1Password). Deploy installs it as the Podman secret `chalk-sfu-otlp-headers`. Without the file, deploy warns and the node exports nothing. Before it installs anything on a node, deploy (and `ci-secret publish`, for the files it bundles) sends each header file it will use an empty request and stops when the endpoint answers 401 or 403, because a node started with a dead token runs normally and silently exports nothing. An unreachable or failing endpoint only warns, and `--firewall-only` skips the check.
- Log export needs `~/.config/chalk-sfu/<env>/otlp-log-headers`, holding the `OTEL_EXPORTER_OTLP_LOGS_HEADERS` value for the API's log dataset, in the same form as `otlp-headers`. Deploy installs it as the Podman secret `chalk-sfu-otlp-log-headers`. Without the file, deploy warns and the node logs to the journal only. The node itself also warns once at start that the log export is off and reports `chalk.sfu.telemetry.logs_export` as 0, so a node that runs without the token is visible on its metrics. A stop gives the node 16 s to drain and 3 s to flush the last records, inside the 20 s `--stop-timeout`.
- Recorder telemetry needs a third file, `~/.config/chalk-sfu/<env>/otlp-trace-headers`, holding the `OTEL_EXPORTER_OTLP_TRACES_HEADERS` value for the API's trace dataset, in the same form as `otlp-headers`. Deploy installs it as the Podman secret `chalk-sfu-otlp-trace-headers`. The SFU itself exports no traces, so only the capture worker reads it.
- The capture worker (`chalk-recorder-capture`) exports its logs, traces and metrics to the same OTLP endpoint as the SFU. The deploy sets `CHALK_RECORDER_OTLP_ENDPOINT` in `capture.env` and maps `chalk-sfu-otlp-headers`, `chalk-sfu-otlp-log-headers` and `chalk-sfu-otlp-trace-headers` to the metrics, logs and traces header variables in the capture unit. An exporter without its header is rejected on every batch, so telemetry turns on only when all three files exist; with fewer, the deploy warns and the worker keeps its logs in the journal. To turn it on, put the three files in the operator directory (tokens come from 1Password; the files stay in that directory with mode 0600, never in Git), run `deploy <env> <node address>`, and look for `recording.capture_finished` rows from service `chalk-recorder-capture` in the log dataset. To turn it off, delete `otlp-trace-headers` (or any of the three) and deploy again. Render workers on the on-demand recorder fleet are not wired here: their environment comes from the fleet bootstrap, not from this deploy.
- `deploy <staging|production> <node address> [--force|--firewall-only]` aligns the node's ufw with its cloud firewall, builds the image at the current commit, installs certificates as Podman secrets, renders settings for the node's size (packet budget, steal limit, `GOMEMLIMIT` and container memory by node size; the table is `features/media/sfu/internal/config/node.json`, with its reasoning in [capacity calibration](../../docs/plans/sfu-capacity-calibration.md)), drains the running node until it reports zero `allocations` and `cleanupDebt`, restarts it and checks `/readyz` through an SSH tunnel. If `SFU_DRAIN_TIMEOUT` (default 3600 seconds) ends first, deploy undrains and exits, because a restart then would cut live calls; `--force` accepts that. It fails when the granted receive buffer is below 8 MiB. Running it twice converges.
- A node running a build from before #951 counts standing source leases as allocations, so its drain never reaches zero. Run `deploy <environment> <node address> --force` once, when no live call needs the node. To undo, redeploy the previous image with `--force`.
