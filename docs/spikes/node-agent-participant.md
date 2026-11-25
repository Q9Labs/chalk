# Spike: Node agent participant

Status: throwaway spike, not for merge. The question was whether a plain Node process can join a live Chalk Episode through the existing SDK, appear in Sync, exchange chat, hear each remote participant as tagged PCM, publish synthetic PCM audio that a browser participant receives, and renew short-lived access for a 15 minute call.

## Short answer

Yes. Both Node WebRTC libraries tried joined the local Chalk stack as ordinary participants through the existing Space client platform seam. Sync, roster presence, bidirectional call chat, per-participant audio receive, synthetic-audio publish, and browser interop all passed on loopback.

The smallest practical implementation is a custom platform adapter around `createSpaceClientForPlatform`: custom media devices, custom Sync lifecycle/socket setup, and a custom `SFUClient` media factory using the existing `peerConnectionFactory` seam. No SDK source change was required for the throwaway spike, but the adapter reaches into seams that are not yet a supported Node API.

## Code in this spike

- `spikes/node-agent/agent.mjs`: high-level Node participant, access closure, platform adapter, PCM probes, tone writer.
- `spikes/node-agent/webrtc-adapters.mjs`: `@roamhq/wrtc` and `werift` adapters.
- `spikes/node-agent/run.mjs`: admission, browser-participant orchestration, checks, and measurements. It uses the server SDK to create/reuse an Episode and admit the Node participant, then joins browser guests through the real invite page.
- `spikes/node-agent/package.json` and lockfile: isolated spike dependencies.

The code is deliberately throwaway. It imports the locally built SDK `dist` output and is not part of the workspace build.

## Test setup

The local dev stack was the real API, Sync, and Chalk SFU (`PUBLIC_ORIGIN=http://localhost:3070 pnpm dev`). Chromium used fake capture devices only; Sync and media remained real. Node and browser participants joined the same Episode. Each run wrote evidence under `.verify/node-agent-<run>/result.json` on the test machine; that private evidence is intentionally not committed.

The browser participant used a wall-clock scheduled marker tone. Node measured the first high-RMS PCM frame after the scheduled start. Node published a wall-clock scheduled tone and the browser side measured inbound Opus audio energy/level in WebRTC stats. These are application-observed media delays, not acoustic loopback measurements.

## Functional results

| Check | `@roamhq/wrtc` | `werift` |
|---|---:|---:|
| Node joins and appears in browser roster | PASS | PASS |
| Node sends chat; browser receives it | PASS | PASS |
| Browser sends chat; Node receives it | PASS | PASS |
| Remote browser microphone arrives as PCM | PASS | PASS |
| PCM tagged with participant, publication, source | PASS | PASS |
| Node synthetic PCM audible as browser inbound audio | PASS | PASS |
| Three remote browser microphones arrive as three tagged PCM streams | PASS | PASS |

PCM was 48 kHz mono in both adapters. The 4-participant runs (Node plus three browsers) produced three independent probe objects, each tagged with a different remote participant ID and publication ID.

## Measurements

Measurements are single-loopback-run values on this VM. Browser automation and the agent shared the orchestrator process, so `process RSS/CPU` overstates the agent itself; the later werift run also recorded an agent-delta RSS measurement. Treat them as order-of-magnitude spike data, not capacity planning data.

| Scenario | Library | SDK join | Browser tone to Node PCM | Node tone to browser inbound audio | Orchestrator CPU | Peak process RSS | Remote audio tracks |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2 participants | `@roamhq/wrtc` | 202 ms | 607 ms | 821 ms | 8.4% of one core | 303 MB | 1 |
| 2 participants | `werift` | 328 ms | 394 ms | 822 ms | 9.4% of one core | 315 MB | 1 |
| 4 participants | `@roamhq/wrtc` | 245 ms | 60 ms | 319 ms | 11.8% of one core | 333 MB | 3 |
| 4 participants | `werift` | 360 ms | 18 ms | 321 ms | 11.0% of one core | 355 MB | 3 |

Additional werift 4-participant process measurements after agent construction: about 11.9% of one core and about 28 MB RSS delta. That is the best per-agent estimate from this spike, but it still includes SDK bookkeeping and the measurement probes.

The browser-to-Node numbers varied widely because detection depends on browser audio-clock startup, Opus frameing, the scheduled marker, and a simple RMS threshold. The consistent interpretation is that media arrives in the hundreds of milliseconds or less on loopback after warm-up, not that 18 ms or 607 ms is a stable library property. The Node-to-browser measurement has the same limitation; it detects inbound decoded audio energy, not sound leaving a speaker.

## Access renewal

_PLACEHOLDER_RENEWAL_

## Library notes

### `@roamhq/wrtc`

What worked:

- The standard-looking `RTCPeerConnection` worked through the existing `peerConnectionFactory` seam with no configuration patch.
- `nonstandard.RTCAudioSink` exposed decoded PCM for each remote track.
- `nonstandard.RTCAudioSource` accepted PCM directly and produced a browser-audible Opus microphone publication.

Concerns:

- The package wraps an old native WebRTC build (M106). That is a security, codec, interoperability, and maintenance risk for a supported agent.
- Its native process/thread lifecycle needs explicit shutdown testing; early standalone instantiation did not exit promptly even after `close()`.
- PCM access is nonstandard and library-specific.

### `werift`

What worked:

- The connection interoperated with the Chalk SFU after one configuration adaptation.
- RTP receive hooks exposed remote Opus packets; decoding them with `@discordjs/opus` yielded PCM frames.
- PCM could be encoded to Opus and written as RTP with payload type 111, a 48 kHz timestamp, and 20 ms frames; browsers received it as audio.

Required adaptation and concerns:

- Chalk's media client passes `iceCandidatePoolSize: 1`; werift throws because positive ICE candidate pool sizes are unsupported. The adapter replaces it with zero. A supported Node platform either needs a werift-specific configuration sanitizer or the SDK needs to make this browser hint optional.
- PCM is not a first-class track API. The spike manually packetizes/depacketizes Opus RTP. This loses the mature media pipeline behaviors normally supplied by WebRTC (jitter concealment, audio processing, encoder rate control, lip-sync-related timestamps, and robust loss handling).
- Manual RTP construction must exactly match the negotiated payload type and timestamp rules. The spike assumes Opus payload type 111 and mono 48 kHz audio because that is what the Chalk SFU negotiates today.
- `werift` implements enough of the browser API for this path, but it is not API-identical. Any production adapter needs conformance tests around transceiver direction, MID assignment, renegotiation, connection replacement, and statistics.

## What had to change or be supplied for Node

No Chalk SDK file was edited. The spike supplied these platform pieces outside the SDK:

1. `mediaDevices.getUserMedia` returned a pre-built audio-only `MediaStream` instead of browser capture.
2. `peerConnectionFactory` constructed the library-specific peer connection.
3. `createMediaClient` constructed `SFUClient` directly so `onRemoteTrack` could attach PCM sinks. The production browser factory does not expose that callback through the high-level platform object.
4. Sync used a simple always-active/online lifecycle and the React Native WebSocket factory shape rather than browser window/document lifecycle.
5. Whiteboard was disabled. Chat text still uses Sync collaboration and does not need browser file storage.
6. Offline actions used the in-memory default because there is no `localStorage`.
7. Foreground and screen capture were replaced with no-op/unsupported implementations.
8. Node 24 supplied `fetch`, `crypto.randomUUID`, and a browser-shaped `WebSocket`.

The existing media code already guards most direct `document` uses. The spike did not need browser globals.

## Smallest supported `chalk-agent` path

### Phase 1: silent listening

1. Publish a documented Node platform adapter in the TypeScript client, or export a supported `createNodeSpaceClient` package that wraps `createSpaceClientForPlatform`.
2. Make the media factory injectable without copying React Native/binding internals. In particular, expose a supported way to pass `peerConnectionFactory` and `onRemoteTrack` while retaining the standard `SFUClient` wiring.
3. Define the Node WebRTC capability contract: configuration sanitization, ICE/DTLS requirements, Opus support, renegotiation behavior, statistics, and shutdown.
4. Add a first-class audio-frame observer API. It should emit frames with participant ID, publication ID, source, sequence/timestamp, sample rate, channel count, and loss/concealment metadata. Do not expose raw library track objects as the supported contract.
5. Support a true listen-only join that does not publish a microphone track at all, while retaining normal subscription and roster behavior. This spike always published silence because it reused the normal microphone path.

### Phase 2: speaking

1. Add a first-class PCM audio source with explicit sample rate, channels, frame duration, backpressure, timestamping, start/stop, and underrun behavior.
2. Hide codec/payload negotiation inside the adapter. Callers should write PCM, not Opus RTP.
3. Conformance-test Opus packet loss, renegotiation, connection replacement, publication pause/resume, and SFU restart.
4. Add deterministic shutdown and per-agent CPU/memory benchmarks outside the browser-driving process.

### Phase 3: face video and screen tracks

1. Add encoded-frame or raw-frame video source/sink contracts. Do this only after audio is stable; video requires codec negotiation, simulcast/layer policy, keyframe requests, bandwidth allocation, and much higher CPU.
2. Reuse the existing screen-share lease and publication lifecycle rather than treating screen as a special agent-only side path.
3. Test pause/resume, tile visibility, layer selection, screenshare audio, and connection replacement against the real SFU.

## Risks

- **Library maintenance:** `@roamhq/wrtc` is native but old; `werift` is active but requires more media-pipeline work.
- **Media correctness:** manual Opus/RTP handling in werift is easy to get subtly wrong under loss or renegotiation.
- **Measurement validity:** these numbers are loopback, one VM, no impairment, one process, and simple RMS/energy detection.
- **Production hardening:** credential renewal under connection replacement, SFU restart, network loss, CPU pressure, and long-running memory fragmentation remains untested.
- **Security/privacy:** PCM access is sensitive. A supported package needs explicit process isolation, retention limits, and redaction-safe diagnostics.
- **Cost:** the spike does not establish a reliable per-agent steady-state cost because the measurement process also ran browser automation.

## Not tested

- Face video or screen-share publication.
- More than four total participants.
- Network loss, jitter, NAT beyond the local ICE-lite setup, or non-loopback deployment.
- SFU restart or media connection replacement during a live call.
- Literal speaker output; browser audibility means decoded inbound audio energy in WebRTC stats.
- WAV-file playback specifically. The spike generated PCM tones; a WAV input would be a trivial PCM feeder only in the uncompressed 48 kHz case, but that path was not implemented.
- Long-term memory leaks beyond the short runs described here.
- Production authentication, tenancy isolation, or deployment packaging.
