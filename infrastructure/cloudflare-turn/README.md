# Cloudflare TURN key

Creates the environment's Cloudflare TURN key. The API mints short-lived TURN
credentials from it for each join, so clients behind strict NATs and firewalls
reach the SFU over UDP 3478, TCP, or TLS on 443. TURN is free with the SFU.

The key's name is the runtime input pair `CHALK_CLOUDFLARE_TURN_KEY_ID` and
`CHALK_CLOUDFLARE_TURN_API_TOKEN`. Their values live in the environment's
`api-env` SSM `SecureString` (see
[`../managed-episode/contracts/runtime-inputs.json`](../managed-episode/contracts/runtime-inputs.json)),
never in Git. The managed runtime validator requires both.

```sh
tofu init -backend-config=backend.hcl
tofu apply -var environment_name=nightly -var cloudflare_account_id=ACCOUNT_ID
# TF_VAR_cloudflare_api_token comes from 1Password.
```

Then set `CHALK_CLOUDFLARE_TURN_KEY_ID=$(tofu output -raw turn_key_id)` and
`CHALK_CLOUDFLARE_TURN_API_TOKEN=$(tofu output -raw turn_api_token)` in the
environment's `api.env` SSM value and redeploy. Do not print either value.
Destroying the resource revokes every credential minted from it.
