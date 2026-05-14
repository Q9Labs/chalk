# Cloudflare SFU vs mediasoup Capabilities

This note compares Cloudflare SFU and mediasoup at the low-level SFU primitive layer for Chalk.

The short version:

```text
Cloudflare SFU:
  Gives Chalk a global programmable media switchboard.

mediasoup:
  Lets Chalk become the media switchboard.
```

## Best Fit

| Goal | Better Default |
| --- | --- |
| Own Chalk runtime, avoid media infra ops | Cloudflare SFU |
| Own media topology, routing, and debugging deeply | mediasoup |
| Start quickly with global reach | Cloudflare SFU |
| Build a custom realtime-media platform | mediasoup |
| Keep infra cost predictable at small/mid scale | Cloudflare SFU |
| Optimize infra cost at very high scale with strong ops | mediasoup |

## Cloudflare SFU: Cool Things Chalk Can Do

Cloudflare SFU is useful when Chalk wants low-level control over sessions and tracks without operating the media fleet.

| Capability | Why It Is Useful |
| --- | --- |
| Track-level routing | Chalk can decide exactly who receives which audio, video, or data tracks. |
| No room abstraction | Chalk keeps its own room state, participants, permissions, and lifecycle. |
| Global edge media path | Users can connect through nearby Cloudflare infrastructure instead of one Chalk-hosted region. |
| Simulcast support | Publishers can send multiple quality layers; Cloudflare can switch layers automatically or by API preference. |
| DataChannel fanout | Useful for low-latency ephemeral room events, reactions, cursor hints, lightweight presence, or game-like state. |
| TURN/SFU bundled model | Chalk has less NAT/firewall infrastructure to own directly. |
| Media Transport Adapters | Tracks can be bridged to external systems for AI, transcription, recording pipelines, or media processing. |
| Usage-based pricing | Early and spiky traffic does not require capacity planning. |

Good Chalk shape:

```text
Chalk owns:
  room state
  permissions
  sync engine
  reconnection behavior
  recording bot orchestration
  diagnostics and support bundles
  UX/runtime

Cloudflare owns:
  media routing
  TURN
  edge placement
  packet forwarding
```

## Cloudflare SFU: Things Chalk Cannot Deeply Control

Cloudflare SFU gives primitives, but not full media-server ownership.

| Limitation | Why It Matters |
| --- | --- |
| No custom SFU internals | Chalk cannot patch congestion behavior, RTP forwarding internals, worker scheduling, or packet handling. |
| No exact topology ownership | Chalk does not choose exact machine placement, cross-region routing, failover internals, or edge behavior. |
| One-way DataChannel primitive | Bidirectional behavior requires explicit paired channels. |
| Recording is external | Chalk needs a bot, adapter, or pipeline for recording and composition. |
| Product-level observability boundary | Chalk sees what Cloudflare exposes, not process-level RTP/worker internals. |
| Vendor limits apply | API rates, adapter formats, codec support, and feature timing are Cloudflare-owned. |

## mediasoup: Cool Things Chalk Can Do

mediasoup is useful when Chalk wants deep ownership of the media layer itself.

| Capability | Why It Is Useful |
| --- | --- |
| Full topology ownership | Chalk decides regions, workers, routers, room placement, failover, draining, and scaling rules. |
| Deep RTP control | Chalk can inspect producers, consumers, transports, RTP parameters, codecs, bitrate, loss, scores, and layers. |
| Custom recording pipeline | Plain RTP/SRTP transports can feed FFmpeg, GStreamer, custom workers, or storage pipelines. |
| Custom media bridges | Chalk can build SIP, RTMP, AI audio, transcription, bot, or analytics bridges in its own architecture. |
| Private deployment | Can run in Chalk's VPC, on bare metal, near a specific customer, or in a controlled region. |
| Deep observability | Worker logs, transport stats, bitrate, packet loss, router-level behavior, and custom dashboards are all possible. |
| No vendor product ceiling | If the behavior is wrong, Chalk can change its topology, service code, deployment model, or fork/patch deeper layers. |

Good Chalk shape:

```text
Chalk owns:
  room runtime
  signaling
  media topology
  worker placement
  TURN
  recording
  observability
  failover
  packet-level debugging
```

## mediasoup: Things Chalk Does Not Get For Free

mediasoup gives power, not a managed platform.

| Missing By Default | Why It Matters |
| --- | --- |
| Global edge network | Chalk must deploy and route media nodes across regions. |
| Managed TURN | coturn, firewall paths, mobile networks, and corporate NATs become Chalk-owned. |
| Autoscaling product | Chalk must build node admission, room placement, draining, failover, and capacity planning. |
| Recording product | Recording is possible, but ingestion, muxing, storage, retries, and sync are Chalk-owned. |
| Room runtime | This is fine for Chalk, but all signaling/state correctness remains our responsibility. |
| Built-in SFU-layer abuse shield | Chalk needs admission control, rate limits, DDoS protection, and infra protections. |
| Simple operational model | More visibility also means more knobs, failure modes, and on-call surface. |

## Performance Framing

mediasoup itself is not the performance compromise. The deployment is.

```text
mediasoup performance:
  excellent inside the regions Chalk deploys well

Cloudflare SFU performance:
  better default consistency across many regions
```

For regionally concentrated traffic, a well-placed mediasoup node can feel extremely fast. For globally scattered classrooms, Cloudflare SFU likely gives better default tail latency and NAT/firewall behavior.

## E2EE Framing

Neither option gives strict media end-to-end encryption by default at the SFU layer.

```text
Normal WebRTC:
  Client A -- DTLS/SRTP --> SFU -- DTLS/SRTP --> Client B

Strict media E2EE:
  Client encrypts encoded frames before the SFU can inspect media payloads.
```

Cloudflare SFU and mediasoup can both be compatible with client-side frame encryption patterns, but Chalk would need to own key management, browser support handling, recording implications, and diagnostics.

## Practical Recommendation

For Chalk today:

```text
Choose Cloudflare SFU if:
  we want to own the Chalk runtime
  we do not want to operate global media infra
  we want faster migration away from RealtimeKit
  we want Cloudflare to own TURN/SFU placement

Choose mediasoup if:
  we want media routing to become a Chalk core competency
  we need very deep packet/RTP observability
  we want custom recording/media bridge pipelines
  we are willing to own global deployment and on-call behavior
```

My current read:

```text
Cloudflare SFU is the cleaner product architecture move.
mediasoup is the deeper infrastructure sovereignty move.
```

