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

The switch lets a Space choose `chalk_sfu`, and the allowlist decides which
Spaces may:

```sh
CHALK_SFU_ALLOWED_SPACES=<space id>,<space id>
```

The list holds Space IDs, comma separated. An empty or missing list allows no
Space even when the switch is on, and `*` allows every Space (staging only). A
Space outside the list cannot be created or updated with `chalk_sfu`, and an
Episode of a Space outside the list starts on Cloudflare even when the Space or
its Tenant default says `chalk_sfu`. Changing the list changes only new
Episodes: a live Episode keeps the provider its binding pinned. Keep the real
list in the private API settings, not in Git. Production keeps the switch off
until the M7 canary.

## Run the canary

Move internal Spaces one at a time: add the Space ID to
`CHALK_SFU_ALLOWED_SPACES`, redeploy the API, then set the Space's
`media_plane` to `chalk_sfu`. To roll a Space back, set `media_plane` to
`cf_sfu`; live Episodes finish on the node, and new Episodes use Cloudflare. To
stop the whole canary, empty the list.

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

A report passes when every join (including the join of each fault trial) renders within 10 seconds, every short fault
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
