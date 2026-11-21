# Cloudflare TURN egress check

This check reads Cloudflare TURN traffic, which still relays media to the Chalk SFU when a client cannot connect directly. It alerts on relay use before it reaches the monthly free allowance.

Cloudflare's usage alert (`billing_usage_alert`) lists no Realtime product, and the pinned OpenTofu provider cannot create a budget alert, so `egress-check.mjs` reads the GraphQL analytics itself, daily, from the [egress check workflow](../../.github/workflows/cloudflare-egress-check.yml). The thresholds and the 72-hour lookback are constants at the top of the script. A monthly threshold alerts on each daily run until its crossing is 72 hours old, so one missed run or one failed webhook post cannot hide it; Oncall dedupes the repeats. A crossed limit or a query or webhook failure also fails the run, so GitHub emails it.

The token and webhook values live in 1Password vault `dev`. The account ID is a secret only so public run logs mask it.

Run the workflow by hand with `drill` set to send one marked test to Oncall. Oncall acts only on an app and check in its registry, so the keys this job posts must match the ones Oncall's poller registers for Chalk, and a test pins them. A drill never reads Cloudflare, so it tests the webhook alone.

To undo, delete the workflow file and this folder, and remove the three secrets.
