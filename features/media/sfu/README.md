# Chalk SFU

A standalone Go service that forwards Participants' audio and video as a second media provider beside Cloudflare Realtime. The design and the milestone plan are in the SFU design pull request (#796). This covers milestones M1 (service skeleton with real single-layer push and pull) and M2 (retry-safe lifecycle, admission, negotiated close). The API reaches it through the `chalk_sfu` media-plane adapter.

The module is `github.com/q9labs/chalk/features/media/sfu`. It never imports `apps/api/internal`. The API adapter will translate between the public `protocol` package and its own ports.

## What M1 does

- **Control** on TCP 8443 over mutual TLS (TLS 1.3). The server certificate and the client CA come from files. The client certificate must also name the expected service (`SFU_CLIENT_IDENTITY`, a DNS or URI SAN), so a certificate from the right CA but another service gets 403. The listener binds all interfaces by default, because the service is public: mutual TLS and the cloud firewall guard it. Set `SFU_CONTROL_ADDR` to bind elsewhere.
- **Health**: `GET /healthz` (process is up, no identifiers) and `GET /readyz` (node incarnation, session count, packet budget and reserved packets; 503 while draining). Both sit on the same mutual-TLS listener, and `/readyz` also needs the service identity, like `/v1`.
- **Sessions** under `/v1`, each scoped to Tenant, Episode, Participant and generation:
  - `POST /v1/sessions` creates a session. The operation ID makes a retry return the same connection ID, also after that session closed, and reusing it with another body fails with 409. The node keeps the create records of the last 4096 closed sessions. A create with a new operation ID closes the Participant's live session and replaces it, at a newer or the same generation, because the API replaces a media connection that way; an older generation is refused.
  - `POST /v1/sessions/{id}/tracks` pushes local tracks (client offer, SFU answer) or pulls remote tracks (no SDP, SFU offer). A request is all local or all remote. Failed tracks return per-track errors while the rest succeed.
  - `POST /v1/sessions/{id}/renegotiate` applies the client's answer to the pending server offer. An unanswered offer closes the session after `SFU_NEGOTIATION_TIMEOUT`.
  - `POST /v1/sessions/{id}/tracks/close` force-closes tracks by MID. Closing an absent MID succeeds.
  - `POST /v1/sessions/{id}/inspect` lists the session's tracks.
    A session or publisher outside the caller's Tenant and Episode reads as gone.
  - An offer is checked before Pion sees it: at most 64 KiB, audio and video sections only, and every section it adds must belong to a track of the request. Tracks that would exceed the publication limit fail the whole request with 429. A section without Opus (audio) or VP8 (video) gets a per-track `invalid_track` error. A session holds at most four times its publication plus subscription limit in media sections over its life, because Pion keeps stopped sections.
  - A delayed create from an older generation stays refused after the newer session closes. The node remembers the highest generation per Participant, for up to 16384 Participants. When the table is full it drops the oldest fence of a Participant with no live session, and it never drops a live session's fence; if every fence is live, a create for a new Participant gets 429. A refused create never drops a fence.
- **M2 additions**:
  - Every mutation takes an `operationId`. The session remembers the digest and the stored response of its last 256 operations, so a retry returns the first result and the same ID with another body fails with 409. The API adapter generates one ID per logical call and reuses it on its HTTP retries.
  - `POST /v1/sessions/{id}/tracks/update` records a subscriber's layer ceiling without SDP. Forwarding stays on the single forwarded layer until a later milestone.
  - `POST /v1/sessions/{id}/tracks/close` also does negotiated close (`force: false`): the client's offer is applied first, then the subscription stops and the SFU's answer returns. `receiveOnly` closes can never stop a publication.
  - `POST /v1/sessions/{id}/remove` ends one session. `POST /v1/episodes/end` closes every session of a Tenant's Episode and reports the count.
  - **Admission** reserves `c * n * (n + 1)` packets/s per Episode, where `c` is the video plus audio stream cost and `n` is the live Participants (at least 2). A create that would push the node past `SFU_PACKET_BUDGET` is refused with 429 `capacity_exceeded`. The budget is the real limit: at the default costs an Episode reaches it at 9 Participants on a 16000 budget and at 13 on 32000. `SFU_MAX_EPISODE_PARTICIPANTS` is a separate safety cap, 16 by default. A reconnect replaces its own session and is not counted twice. `/readyz` reports the budget and the reserved packets.
  - **One screen share** per Episode. A second screen publication gets the per-track error `screen_share_active`.
- **Media**: Opus and VP8 passthrough on one Pion UDP socket (ICE-lite). Keyframe requests from a subscriber are relayed to the publisher. A camera that offers simulcast negotiates it, and the node forwards the first RID whose packets arrive.

Not yet built: layer selection and adaptation, congestion control, NACK policy, ICE restart, certificate rotation and deployment.

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
| `SFU_PACKET_BUDGET`                     | `16000`         | Packets/s budget; set `32000` on `s-2vcpu-2gb`.       |
| `SFU_VIDEO_STREAM_COST`                 | `150`           | Reserved packets/s of one video stream.               |
| `SFU_AUDIO_STREAM_COST`                 | `50`            | Reserved packets/s of one audio stream.               |
| `SFU_MAX_EPISODE_PARTICIPANTS`          | `16`            | 1 to 64. Live sessions allowed in one Episode.        |
| `SFU_NEGOTIATION_TIMEOUT`               | `10s`           | How long a server offer waits for its answer.         |
| `SFU_CONNECT_TIMEOUT`                   | `60s`           | How long a new session may take to connect.           |
| `SFU_SHUTDOWN_TIMEOUT`                  | `15s`           | Graceful stop budget.                                 |

SIGINT or SIGTERM drains the node: `/readyz` fails, new sessions are refused, in-flight requests finish, then every session, the control listener and the UDP socket close.

## Tests

Run the heavy runs on Instabox (`box run -- '...'` from the repository root), not on a laptop.

1. **Loopback integration test** starts the real HTTP service and two real Pion peers. Peer A pushes known RTP. Peer B pulls it and answers the SFU's offer through Renegotiate. It asserts payloads and increasing sequence numbers, close, inspect, duplicate create, a wrong client certificate, a cross-Tenant pull and that every peer, listener, socket and goroutine is gone at the end.

   ```sh
   cd features/media/sfu && go test -race -count=1 ./...
   ```

   `scripts/gate.sh` runs this with format, tidy and vet checks. The repo gate runs it as the `sfu` lane when anything under `features/media/sfu` changes.

2. **Chromium check** builds and starts the service, then drives headless Chromium with a fake camera and microphone. Connection A pushes with the SDK's shape (max-bundle, sendonly transceivers, camera simulcast `h`/`l`). Connection B pulls and answers the server offer. It passes when B decodes video frames and receives audio packets. It needs Playwright's Chromium, so it is not part of the CI gate.

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec playwright install chromium
   cd features/media/sfu && node tests/browser/chromium-check.mjs
   SIMULCAST=0 node tests/browser/chromium-check.mjs   # single-encoding camera
   ```
