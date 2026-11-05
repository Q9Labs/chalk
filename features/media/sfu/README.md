# Chalk SFU

A standalone Go service that forwards Participants' audio and video as a second media provider beside Cloudflare Realtime. The design and the milestone plan are in the SFU design pull request (#796). It has milestone M1 (the service skeleton with real push and pull) and the media side of M4 (simulcast layer routing). Nothing in the API, Sync or the SDK uses it yet.

The module is `github.com/q9labs/chalk/features/media/sfu`. It never imports `apps/api/internal`. The API adapter will translate between the public `protocol` package and its own ports.

## What it does

- **Control** on TCP 8443 over mutual TLS (TLS 1.3). The server certificate and the client CA come from files. The client certificate must also name the expected service (`SFU_CLIENT_IDENTITY`, a DNS or URI SAN), so a certificate from the right CA but another service gets 403. The listener binds all interfaces by default, because the service is public: mutual TLS and the cloud firewall guard it. Set `SFU_CONTROL_ADDR` to bind elsewhere.
- **Health**: `GET /healthz` (process is up) and `GET /readyz` (node incarnation and session count; 503 while draining). Both sit on the same mutual-TLS listener.
- **Sessions** under `/v1`, each scoped to Tenant, Episode, Participant and generation:
  - `POST /v1/sessions` creates a session. The operation ID makes a retry return the same session, and reusing it with another body fails with 409. A newer generation closes the older session; an older or equal generation is refused.
  - `POST /v1/sessions/{id}/tracks` pushes local tracks (client offer, SFU answer) or pulls remote tracks (no SDP, SFU offer). A request is all local or all remote. Failed tracks return per-track errors while the rest succeed.
  - `POST /v1/sessions/{id}/renegotiate` applies the client's answer to the pending server offer. An unanswered offer closes the session after `SFU_NEGOTIATION_TIMEOUT`.
  - `POST /v1/sessions/{id}/tracks/close` force-closes tracks by MID. Closing an absent MID succeeds.
  - `POST /v1/sessions/{id}/inspect` lists the session's tracks.
    A session or publisher outside the caller's Tenant and Episode reads as gone.
  - An offer is checked before Pion sees it: at most 64 KiB, audio and video sections only, and every section it adds must belong to a track of the request. Tracks that would exceed the publication limit fail the whole request with 429. A section without Opus (audio) or VP8 (video) gets a per-track `invalid_track` error. A session holds at most four times its publication plus subscription limit in media sections over its life, because Pion keeps stopped sections.
  - A delayed create from an older generation stays refused after the newer session closes. The node remembers the highest generation per Participant, for up to 16384 Participants. When the table is full it drops the oldest fence of a Participant with no live session, and it never drops a live session's fence; if every fence is live, a create for a new Participant gets 429.
- **Media**: Opus and VP8 on one Pion UDP socket (ICE-lite).
  - A simulcast camera's layers (`h`, `l`, at most three) are each read once. Every subscription forwards one layer: the pull's `simulcast.preferredRid` is its ceiling and `startRid` may start it lower. With `ridNotAvailable` other than `none`, a layer without RTP for one second falls back to the first active RID in ASCII order, and the subscription returns when the layer resumes. A track without RIDs always serves.
  - A switch waits for a keyframe of the new layer and asks for one, at most once per 500 ms per layer. Each subscriber gets its own continuous stream: sequence numbers, timestamps, VP8 picture IDs and TL0PICIDX are rewritten so a switch, a pause, a sequence wrap or reordering never breaks decoding.
  - A pull with `paused` forwards nothing while it keeps its MID. Inspect reports each subscription's `state` (`active` or `paused`), `reason` (`viewer` or `source_inactive`), `revision`, and requested and effective RID, and each publication's layers.
  - Each video layer keeps one second of packets (400 KiB for `h` and for a camera without RIDs, 320 KiB for a screen, 128 KiB for other layers), shared by its subscribers. A subscriber's NACK is answered from it on the media SSRC with the sequence number that subscriber first saw. Keyframe requests go to the layer the subscriber forwards.
  - Streams nobody forwards are still read and discarded, and Pion's per-stream buffers are capped at 128 KiB, so no buffer grows.
  - The forwarding path allocates nothing per packet; `TestForwardingAllocatesNothing` keeps it that way.

Not here yet: the API adapter, SDK changes, layer updates on an existing subscription, adaptation, congestion control, RTX and NACK rate policy, negotiated close, operation-ID replay beyond session create, certificate rotation, deployment and the provider flag.

## Run it

```sh
cd features/media/sfu
SFU_TLS_CERT_FILE=server.pem SFU_TLS_KEY_FILE=server.key \
SFU_CLIENT_CA_FILE=ca.pem SFU_CLIENT_IDENTITY=chalk-api \
SFU_ANNOUNCE_IPS=203.0.113.10 \
go run ./cmd/sfu
```

| Setting                                 | Default         | Meaning                                               |
| --------------------------------------- | --------------- | ----------------------------------------------------- |
| `SFU_CONTROL_ADDR`                      | `:8443`         | Control listener.                                     |
| `SFU_UDP_ADDR`                          | `:50000`        | The one UDP socket every peer shares.                 |
| `SFU_ANNOUNCE_IPS`                      | host interfaces | Addresses placed in ICE candidates (comma-separated). |
| `SFU_ICE_LOOPBACK`                      | `false`         | Offer loopback candidates; local runs only.           |
| `SFU_TLS_CERT_FILE`, `SFU_TLS_KEY_FILE` | required        | Server identity.                                      |
| `SFU_CLIENT_CA_FILE`                    | required        | CA that signs the API's client certificate.           |
| `SFU_CLIENT_IDENTITY`                   | required        | DNS or URI SAN the API's certificate must carry.      |
| `SFU_MAX_SESSIONS`                      | `64`            | 1 to 1024.                                            |
| `SFU_MAX_PUBLISHED_PER_SESSION`         | `8`             | 1 to 32.                                              |
| `SFU_MAX_SUBSCRIPTIONS_PER_SESSION`     | `32`            | 1 to 128.                                             |
| `SFU_MAX_REQUEST_BYTES`                 | `262144`        | 4096 to 1048576.                                      |
| `SFU_NEGOTIATION_TIMEOUT`               | `10s`           | How long a server offer waits for its answer.         |
| `SFU_CONNECT_TIMEOUT`                   | `60s`           | How long a new session may take to connect.           |
| `SFU_SHUTDOWN_TIMEOUT`                  | `15s`           | Graceful stop budget.                                 |
| `SFU_UDP_RECEIVE_BUFFER`                | `8388608`       | Socket receive buffer to request, 256 KiB to 64 MiB.  |

## Deploy

Set `net.core.rmem_max` and `net.core.rmem_default` to 8 MiB (`8388608`) on the host, for example in `/etc/sysctl.d/90-chalk-sfu.conf`. The kernel caps a socket's receive buffer at `rmem_max`, and Linux defaults it to about 208 KiB, which a burst of video from many publishers overflows as UDP receive errors. At start the node logs the size it requested and the size the kernel granted, and warns when it got less.

SIGINT or SIGTERM drains the node: `/readyz` fails, new sessions are refused, in-flight requests finish, then every session, the control listener and the UDP socket close.

## Tests

Run the heavy runs on Instabox (`box run -- '...'` from the repository root), not on a laptop.

1. **Loopback integration test** starts the real HTTP service and two real Pion peers. Peer A pushes known RTP. Peer B pulls it and answers the SFU's offer through Renegotiate. It asserts payloads and increasing sequence numbers, close, inspect, duplicate create, a wrong client certificate, a cross-Tenant pull and that every peer, listener, socket and goroutine is gone at the end.

   ```sh
   cd features/media/sfu && go test -race -count=1 ./...
   ```

   **Layer switching test** (`tests/layers_test.go`) publishes real libvpx VP8 from `tests/testdata` as two simulcast layers with wrapping sequence numbers and picture IDs, reordered packets and ignored keyframe requests. Three subscribers follow the layers as the publisher stops and restarts each one. Their frames are rebuilt, compared byte for byte with the fixtures, checked for decodability across every switch, and decoded with ffmpeg when it is installed. It also NACKs packets on two layers.

   `scripts/gate.sh` runs these with format, tidy and vet checks. The repo gate runs it as the `sfu` lane when anything under `features/media/sfu` changes.

2. **Chromium check** builds and starts the service, then drives headless Chromium with a fake camera and microphone. Connection A pushes with the SDK's shape (max-bundle, sendonly transceivers, camera simulcast `h`/`l`). Connection B pulls and answers the server offer. It passes when B decodes video frames and receives audio packets. With simulcast, connection C pulls `l` while B pulls `h`; the check stops and restarts each encoding twice and asserts that both keep decoding on the expected layer with their MIDs and no new SDP. It then prints each encoding's resolution and encode time. It needs Playwright's Chromium, so it is not part of the CI gate.

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec playwright install chromium
   cd features/media/sfu && node tests/browser/chromium-check.mjs
   SIMULCAST=0 node tests/browser/chromium-check.mjs   # single-encoding camera
   ENCODINGS=3 node tests/browser/chromium-check.mjs   # adds a quarter-size "q" encoding
   ```
