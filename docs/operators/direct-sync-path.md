# Direct Sync path

The direct Sync path lets a client open its Sync WebSocket straight to the managed host over TLS, without the Cloudflare Tunnel. The same door also forwards the API's SFU signalling routes (no client uses them yet). It is off everywhere by default. With it off, clients, Sync and the host behave exactly as before.

## Why

A WebSocket upgrade through the Tunnel from Karachi to a Singapore host takes about 800 ms, because the Cloudflare edge adds about three round trips between the edge and the connector. A trial against a nightly host (since torn down) measured the direct path at these medians over 200 cold connections each:

| Stage                         | Through the Tunnel | Direct |
| ----------------------------- | ------------------ | ------ |
| WebSocket upgrade             | 799 ms             | 88 ms  |
| First `hello` to live state   | 763 ms             | 370 ms |
| TCP to live state, cold start | 1658 ms            | 644 ms |

The trial did not run in production, with real clients, or under load. Treat the numbers as the target for the first nightly cut, not as a promise.

## What exists

| Part                   | Where                                                                                                           | Default                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Client flag            | SDK option `syncDirectUrl`, web build value `CHALK_WEB_SYNC_DIRECT_URL`                                         | unset, so off                    |
| Direct-first socket    | `sdks/typescript/client/src/sync/direct-first.ts`                                                               | not used while the flag is unset |
| TLS proxy on the host  | `infrastructure/managed-episode/direct-sync/` (`direct-sync-proxy`, `Caddyfile`, `chalk-direct-sync-proxy.nft`) | not installed                    |
| Security group and DNS | `infrastructure/managed-episode/direct-sync/opentofu/`                                                          | not applied                      |
| Sync connection bounds | `apps/sync/lib/chalk_sync/transport/direct_limits.ex`                                                           | active only for proxied requests |

No hostname, address or account identifier is stored in Git. The operator supplies them when applying.

## How a client behaves

When `syncDirectUrl` is set, each Sync connection attempt first opens the direct URL with the same path and query as the regular Sync URL. The client treats the attempt as failed when the socket errors or closes before it opens (a refused connection, a DNS failure or a TLS failure all look like this in a browser), or when it has not opened after 2.5 seconds. It then opens the regular Sync URL. The rest of the client sees one socket.

After a failed attempt the client skips the direct URL for 10 minutes, shared by every client in the page, so a blocked path costs at most 2.5 seconds once. A direct socket that opens, delivers at least one server frame and later drops is not a failed attempt: the next reconnect tries the direct URL again. A direct socket that errors or closes before its first server frame is a failed attempt, whatever the close code (a proxy bound answers 1013, a broken path resets), so the next connection uses the Tunnel. A direct URL that is `ws://` is ignored when the regular Sync URL is `wss://`, so the token never travels over plain text.

The whiteboard socket does not use the direct path. Only `/v1/sync` is proxied.

## Turn it on for one environment

Start with nightly. The OpenTofu root accepts only `environment = "nightly"` and fails validation for anything else, and `build-web` passes the direct URL to the nightly build only. Staging and production each need a reviewed change to both before they can use the path. Every step is reversible; see the next section.

1. **Network.** Apply the OpenTofu root in `infrastructure/managed-episode/direct-sync/opentofu/` with the environment, region, instance id, hostname, zone id and the host's public address as variables. It creates one security group that allows inbound TCP 443 and nothing else, attaches it to the host's network interface, and creates DNS-only A records. The host address must survive stop and start, so use an Elastic IP; the nightly host is a spot instance that stops on interruption.
2. **Proxy.** On the host, run `CHALK_DIRECT_SYNC_HOST=<hostname> direct-sync-proxy install` as root (through the environment's SSM document). It downloads a pinned Caddy release, checks its SHA-512, validates the config and starts `chalk-direct-sync-proxy.service`. The proxy forwards two kinds of request and answers 404 to everything else. `/v1/sync` goes to the local Sync port. The SFU signalling routes of the API (`/v1/tenants/*/spaces/*/episodes/*/participants/*/media/sfu/*`, with the `GET`, `POST`, `PUT` and `OPTIONS` methods and a 1 MiB body cap) go to the local API port, so login, admin, OAuth and MCP are never served here. For both, it replaces `Cf-Connecting-Ip` and `X-Forwarded-For` with the TCP peer address and sets `X-Chalk-Ingress: direct`; the API and Sync trust those headers only from this proxy. The proxy adds no CORS headers: the API answers preflights itself. The unit also loads an nftables table, `chalk_direct_proxy`, that drops a source's new connections above 30 a second (burst 100) and its connections above 512 (the count follows connection tracking, so closed connections count until they leave TIME_WAIT). The table is removed when the unit stops.
3. **Certificate.** Caddy issues the certificate itself over TLS-ALPN-01 on port 443 as soon as DNS points at the host and the security group is open. No DNS token or other secret is on the host. Run `direct-sync-proxy status` to confirm it serves a certificate.
   3a. **API signalling.** Set `CHALK_API_DIRECT_URL` to the same https origin (no path) in the API environment and restart the API. Each new own-SFU join then carries `directSignalingUrl` in its grant capabilities, and the direct door admits at most 300 requests in 10 seconds from one client address before any credential check (`429` with `Retry-After` over that). No client uses the field yet. Unset it to stop advertising.
4. **Sync bounds.** The defaults apply without configuration. To change them, set these in the Sync environment file and restart Sync: `CHALK_SYNC_DIRECT_MAX_SOCKETS_PER_IP` (64), `CHALK_SYNC_DIRECT_MAX_UNAUTHENTICATED_PER_IP` (8), `CHALK_SYNC_DIRECT_MAX_SOCKETS_PER_TENANT` (512), `CHALK_SYNC_DIRECT_UPGRADES_PER_IP_WINDOW` (20 per 10 seconds). Raise the per-IP values before a large event behind one office network.
5. **Flag.** Set the repository variable `CHALK_NIGHTLY_SYNC_DIRECT_URL` to `wss://<hostname>/v1/sync` (the OpenTofu output `direct_sync_url`) and cut a nightly web release. The `build-web` job passes it to the nightly build only, as `CHALK_WEB_SYNC_DIRECT_URL`, so the production artifact in the same run never gets it. Production needs its own wiring change in that job. Native apps pass `syncDirectUrl` to `createNativeSpaceClient`. The web release fails if the value is not a `wss://` URL ending in `/v1/sync`.
6. **Check.** Join a call from a real network and confirm the Sync socket opened on the direct hostname, `sync_socket_open` took about one round trip, and the `ingress` attribute is `direct` on the `sync.websocket.handshake` span.

Turn the flag on before the proxy and the client falls back after 2.5 seconds on every first attempt, so install and verify the proxy first.

## Undo

Use the first row that fits.

| Goal                                 | Action                                                                                                                                 | Needs a deploy | Effect                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop advertising the API door        | Unset `CHALK_API_DIRECT_URL` and restart the API                                                                                       | no             | New joins carry no `directSignalingUrl`.                                                                                                                                                                                                                |
| Stop all direct traffic now          | `systemctl stop chalk-direct-sync-proxy` on the host, or delete the DNS records with `tofu destroy -target=cloudflare_dns_record.ipv4` | no             | Open direct sockets drop and reconnect. A refused connection or missing DNS name fails at once; the client then uses the Tunnel and skips the direct URL for 10 minutes. A dropped packet path (closed security group) costs 2.5 seconds once per page. |
| Turn the flag off for new page loads | Unset `CHALK_NIGHTLY_SYNC_DIRECT_URL` and cut a web release. Remove `syncDirectUrl` in native apps and ship.                           | **yes**        | The value is compiled into the web build. Pages that are already loaded, or cached, keep trying the direct URL and fall back, so do the first row as well.                                                                                              |
| Remove everything                    | `direct-sync-proxy remove --purge` on the host, then `tofu destroy` for the OpenTofu root                                              | no             | Security group, DNS and proxy are gone. Sync bounds stay in the code and apply to nothing.                                                                                                                                                              |

The flag does not switch off without a deploy. The first row is the no-deploy undo, and the fallback is what makes it safe.

## What to watch

**Sync metrics.** Sync `/metrics` counts every direct admission decision as `chalk.sync.direct.admission.<outcome>.<stage>`. The outcomes are `accepted`, `rate_limited`, `ip_limit`, `tenant_limit` and `overloaded`. The stages are `upgrade` (before the WebSocket upgrade), `register` (the socket's slot) and `authenticated` (the tenant bound at `hello`). Expect almost only `accepted`. A steady `ip_limit` from one network is a shared office that needs a higher per-IP value. Any `overloaded` means the limiter did not answer in time, or tracked too many addresses, and Sync refused the connection with 503; look at the node.

**Sync logs and traces.** A client that sends a frame over 64 KiB is closed with code 1009 and Bandit logs `max_frame_size_exceeded` at error level. A single one is a broken client; a stream of them from one address is abuse. Sockets that exceed a bound close with 1013 ("try again later"), and Sync records the reason `direct_limit` on `sync.websocket.closed`. Direct sockets carry `ingress=direct` on `sync.websocket.handshake`, so split latency and closes by ingress.

**Proxy and certificate.** Run `direct-sync-proxy status` from a check or by hand. It fails when the service is down, when the nftables caps are not loaded, when no certificate is served, or when the certificate expires within 14 days. Caddy renews at about two thirds of the certificate's life and logs every attempt in the journal (`journalctl -u chalk-direct-sync-proxy | grep -i acme`). A failed renewal shows up first as that log line, then as `status` failing 14 days before expiry, and last as clients falling back to the Tunnel when the certificate has expired. Certificates live in `/var/lib/chalk-direct-sync` and survive a restart of the host.

**Client latency.** The nightly scorecard's Sync connect and join stages should drop for far clients. If they do not, check that the direct socket opened: a Sync upgrade near 800 ms from a far network means the client fell back.

## Risks to know about

- A direct DNS name discloses the host's public address. The Tunnel hid it. Per-IP and per-tenant bounds stop one noisy client, not a distributed flood, and the nightly host is small. The undo above is the response to an attack; do not enable the path for production without a plan for that.
- Sync trusts `Cf-Connecting-Ip` and `X-Chalk-Ingress` from the proxy. Sync's port is published only on the host's loopback, so no outside client reaches it without passing the proxy or the Tunnel. A client that sets `X-Chalk-Ingress: direct` through the Tunnel only subjects itself to the direct bounds.
- The security group has no egress rules of its own. Caddy's certificate requests use the host's existing egress.

## IPv6

The nightly VPC and subnet had no IPv6 in the trial, and the host had no IPv6 address. Browsers choose between address families themselves, so an IPv4-only name works for every client: a mobile network that prefers IPv6 uses its carrier's NAT64 or dual-stack path to reach the A record. The trial measured the same medians over IPv4 and IPv6 (upgrade 88 ms both), so IPv6 is not a latency gain.

Ship the A record alone. Add an AAAA record only after the whole chain works, and check reachability from outside before creating the record, because an unreachable AAAA adds a delay to every first attempt. The chain is an IPv6 block on the VPC and subnet, a `::/0` route to the internet gateway, an IPv6 address on the host's network interface that is configured in the OS and persists across stop and start (the trial added it by hand at runtime, and it was lost on restart), and the OpenTofu variable `ipv6_address`, which then adds the AAAA record and the IPv6 security group rule. If the VPC change is too large for one environment, leave IPv6 out.

## Not proved yet

- A live nightly cut with real Karachi clients: the table above comes from one trial from one network.
- That the proxy unit and Caddy configuration run on the managed host's operating system. The configuration validates and the header handling was checked against a local Caddy, but the unit, `DynamicUser` state directory and TLS-ALPN-01 issuance have not run on the host.
- Behaviour under a connection flood on a small host.
