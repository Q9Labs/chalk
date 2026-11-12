# Direct Sync path

The direct Sync path lets a client open its Sync WebSocket straight to the
managed host over TLS, skipping the Cloudflare Tunnel. The same door also
forwards the API's SFU signalling routes. It is off everywhere by default, and
with it off nothing behaves differently. Production does not use it.

## Why

A WebSocket upgrade through the Tunnel from Karachi to a Singapore host took
about 800 ms in a trial, because the Cloudflare edge adds roughly three round
trips to the connector. The direct path took about 90 ms, and time from TCP to
live state fell from about 1.7 s to 0.6 s. The trial was one network against one
nightly host, with no load and no production clients. Treat the figures as a
target.

## How it works

- A client with a direct URL tries it first and falls back to the Tunnel on error, early close or a 2.5 second timeout. After a failure every client in the page skips the direct URL for 10 minutes, so a blocked path costs at most one 2.5 second wait (`sdks/typescript/client/src/sync/direct-first.ts`).
- A grant for an own-SFU Space can carry `directSignalingUrl` from
  `CHALK_API_DIRECT_URL`. With the SDK default `directPath: "auto"`, the client
  then uses the door for SFU signalling and, when the build sets no
  `syncDirectUrl`, for Sync. `directPath: "off"` ignores it (the web app sets this
  from `?direct=off` for a control arm).
- A signalling write is never replayed on the Tunnel after it left the browser,
  because the protocol has no idempotency key and a lost response does not show
  whether the API applied it. Only reads are replayed.
- The whiteboard socket, login, admin, OAuth and MCP never use the door.
- The SDK records which path each use took (`transport_path` in
  `getDiagnostics()`), so a trial can split joins into arms and count fallbacks.
- The warm lobby socket opens before a grant exists, so it needs the static
  `syncDirectUrl`. Set both the static and the grant value on a trial arm, or the
  direct arm pays a socket open the control arm's warm socket does not.

## Host pieces

Code and config live in `infrastructure/managed-episode/direct-sync/`: a Caddy
TLS proxy with an nftables connection cap, and an OpenTofu root for the security
group and DNS. Sync enforces connection bounds for proxied requests in
`apps/sync/lib/chalk_sync/transport/direct_limits.ex`. No hostname, address or
account identifier is stored in Git.

The proxy forwards only `/v1/sync` and the SFU signalling routes, and answers 404
to everything else. It overwrites the client address headers with the TCP peer
and sets `X-Chalk-Ingress: direct`. The API and Sync trust those headers only
from this proxy, and Sync's port is bound to loopback so nothing else can reach
it. Caddy gets its own certificate over TLS-ALPN-01, so the host holds no DNS
token.

## Turn it on (nightly only)

The OpenTofu root accepts only `environment = "nightly"`, and `build-web` passes
the direct URL to the nightly build only. Staging or production need a reviewed
change to both.

1. Apply the OpenTofu root with a stable public IPv4 address (for example an Elastic IP), because the nightly host is a spot
   instance whose address must survive stop and start.
2. Install the proxy on the host as root with
   `CHALK_DIRECT_SYNC_HOST=<hostname> direct-sync-proxy install` and confirm
   `direct-sync-proxy status` shows a valid certificate. Do this before the flag:
   a flag with no proxy makes every first attempt wait 2.5 seconds.
3. Set `CHALK_API_DIRECT_URL` (an https origin, no path) in the API environment
   and restart the API.
4. Set the repository variable `CHALK_NIGHTLY_SYNC_DIRECT_URL` to
   `wss://<hostname>/v1/sync` and cut a nightly web release. Native apps pass
   `syncDirectUrl` to `createNativeSpaceClient`.
5. Join from a real network. The Sync socket should open on the direct hostname
   and `sync.websocket.handshake` should carry `ingress=direct`.

Sync bounds have defaults. Override them with the `CHALK_SYNC_DIRECT_*`
environment variables listed in `apps/sync/config/runtime.exs`. Raise the per-IP values before a
large event behind one office network.

## Production

Production keeps running on the Tunnel until someone does all of this, each step
needing the owner's go-ahead because DNS and the production security group
change:

1. Widen the `environment` validation in `infrastructure/managed-episode/direct-sync/opentofu/variables.tf` (it accepts only `nightly`) in a reviewed change, apply the root for production and install the proxy.
2. Check from outside the VPC that 443 answers, a Sync upgrade and an SFU
   preflight succeed, and every other path returns 404.
3. Pass a nightly trial first: at least 30 joins per arm from at least 2 Pakistani
   ISPs, a median at least 0.5 s faster, and a fallback rate of 2% or less.
4. Plan for abuse. The door discloses the host's public address, and the bounds
   stop one noisy client, not a distributed flood.
5. Set `CHALK_API_DIRECT_URL` in the production API and redeploy.

`scripts/releases/web.py` refuses a static `CHALK_WEB_SYNC_DIRECT_URL` on a
production web build, and the grant door does not need it. Keep that guard.

## Undo

Use the first row that fits. The fallback is what makes the no-deploy rows safe.

| Goal                                 | Action                                                                                                                                                  | Deploy |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Stop advertising the API door        | Unset `CHALK_API_DIRECT_URL`, restart the API. Clients that already hold a grant keep the door until it expires or the 10 minute memory moves them off. | no     |
| Stop all direct traffic now          | `systemctl stop chalk-direct-sync-proxy`, or delete the DNS records. Open sockets drop and reconnect over the Tunnel.                                   | no     |
| Turn the flag off for new page loads | Unset `CHALK_NIGHTLY_SYNC_DIRECT_URL` and cut a web release. Loaded pages keep trying and fall back, so also do the row above.                          | yes    |
| Remove everything                    | `direct-sync-proxy remove --purge`, then `tofu destroy`                                                                                                 | no     |

## What to watch

- Sync `/metrics` counts every admission as
  `chalk.sync.direct.admission.<outcome>.<stage>`. Expect almost only `accepted`.
  A steady `ip_limit` from one network is a shared office that needs a higher
  per-IP bound. Any `overloaded` means Sync refused with 503: look at the node.
- Sockets over a bound close with 1013 and the reason `direct_limit`. A frame over
  64 KiB closes with 1009. One is a broken client; a stream from one address is
  abuse.
- `direct-sync-proxy status` fails when the service is down, the nftables caps are
  missing, no certificate is served, or the certificate expires within 14 days.
  Check `journalctl -u chalk-direct-sync-proxy | grep -i acme` for renewal
  attempts.
- A Sync upgrade near 800 ms from a far network means the client fell back.

## IPv6

Ship the A record alone. Browsers pick the address family themselves, and the
trial measured the same latency over IPv4 and IPv6. Add an AAAA record only after
the whole chain works (VPC and subnet IPv6, a default route, an address on the
host that persists across stop and start) and you confirmed reachability from
outside, because an unreachable AAAA delays every first attempt.

## Not proved

- A live nightly with real Karachi clients, and blocked-door behaviour on real
  ISPs (TLS interception, a middlebox dropping 443).
- The proxy unit, `DynamicUser` state and TLS-ALPN-01 issuance on the managed
  host's operating system.
- Behaviour under a connection flood on a small host.
