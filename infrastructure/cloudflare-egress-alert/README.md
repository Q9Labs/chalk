# Cloudflare SFU and TURN egress check

Realtime SFU and TURN share one 1,000 GB monthly free allowance and cost USD
0.05 per GB past it
([pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)).
Traffic between TURN and our SFU is not charged twice, so the extra cost TURN
can add is TURN traffic that does not go to our SFU, such as credential abuse.
This check covers SFU growth and that abuse.
Cloudflare's usage alert (`billing_usage_alert`) lists no Realtime product, and
the pinned OpenTofu provider cannot create a budget alert, so this job reads
the numbers itself.

`egress-check.mjs` runs daily from
the [egress check workflow](../../.github/workflows/cloudflare-egress-check.yml).
It sums SFU and TURN egress from Cloudflare GraphQL analytics
(`callsUsageAdaptiveGroups` and `callsTurnUsageAdaptiveGroups`) and posts to the
Oncall webhook when:

- the last 24 hours sent 100 GB or more (about 9 Mbps sustained), or
- the month-to-date total crossed 500 GB or 800 GB within the last 72 hours. A
  threshold alerts on each daily run until its crossing is 72 hours old, so one
  missed run or one failed webhook post cannot hide it. Oncall dedupes the repeats.

A crossed limit also fails the run, so GitHub emails the failure. A query or
webhook failure fails the run the same way. A GB is 10^9 bytes.

The workflow reads the repository variable `CLOUDFLARE_ACCOUNT_ID` and the
secrets `CLOUDFLARE_ANALYTICS_TOKEN` (read-only analytics) and
`ONCALL_WEBHOOK_URL`. Their values live in 1Password vault `dev`.

Run the workflow by hand with `drill` set to send one marked test to Oncall.
Oncall acts on a payload only for an app and check in its registry. The keys this
job posts are `cloudflare-sfu-turn-egress:chalk:24h` and `...:month-500gb` and
`...:month-800gb`, the same ones Oncall's poller registers for Chalk, and a test pins
them. A drill posts the 24 h key and never reads Cloudflare, so it tests the webhook alone.

```sh
node --test infrastructure/cloudflare-egress-alert/egress-check.test.mjs
```

To undo, delete the workflow file and this folder, and remove the two secrets
and the variable.
