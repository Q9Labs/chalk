# Chalk network check

An unlisted static page compares 20 unauthenticated Sync upgrades with a separate
Cloudflare Worker’s WebSocket and HTTP response, over about one minute. It does
not request a grant or create a call, participant, or seat. Results stay in the
browser. The controls have no storage, proxy or logging code.

Deploy the new, standalone control with the existing Wrangler login:

```sh
wrangler deploy --config scripts/network-check/wrangler.jsonc
```

Replace `__CONTROL_ORIGIN__` in a copy of `network-check.html` with the deployed
Worker HTTPS origin, and upload that copy next to the private QA tracker object
as `network-check.html`. Keep the private hosting configuration outside Git.
The control permits browser upgrades only from `https://qa.q9labs.ai`.

Sync’s `/v1/sync` validates the upgrade, not the Origin or tenant. A healthy browser
gets `open` before any hello is required. The check closes it immediately without
sending a token. Verify this from the deployed QA page before sharing the link.

`OPEN` proves an upgrade succeeded. A failed browser socket does not expose its
HTTP status, so this page cannot name an edge, ISP, QUIC or hostname fault.
Close 1006 is evidence of an abnormal close, not a diagnosis. Background tabs can
delay the schedule; the page reports whether it was hidden during a run.

Undo: delete the new QA object and delete only the `q9-qa-network-control` Worker.
Neither operation changes Chalk or the existing QA bug list.
