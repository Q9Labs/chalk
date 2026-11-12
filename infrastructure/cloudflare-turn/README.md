# Cloudflare TURN key

Creates the environment's Cloudflare TURN key. The API mints short-lived TURN credentials from it for each join, so clients behind strict NATs and firewalls reach the SFU over UDP 3478, TCP, or TLS on 443.

TURN used together with our SFU adds no charge, because Cloudflare does not bill traffic between TURN and the SFU twice. TURN traffic that does not go to our SFU costs USD 0.05 per GB, and SFU and TURN share one 1,000 GB free allowance each month ([pricing](https://developers.cloudflare.com/realtime/turn/)). Credential abuse is the only way to pay for TURN alone.

The key's outputs (`turn_key_id`, `turn_api_token`) become `CHALK_CLOUDFLARE_TURN_KEY_ID` and `CHALK_CLOUDFLARE_TURN_API_TOKEN` in the environment's `api.env` SSM value ([runtime inputs](../managed-episode/contracts/runtime-inputs.json)), never in Git. Do not print either value. `TF_VAR_cloudflare_api_token` comes from 1Password. After apply, set both values and redeploy.

Destroying the resource revokes every credential minted from it.
