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

The switch lets a Space choose `chalk_sfu`; every other Space keeps Cloudflare.
Production keeps the switch off until the M7 canary.
