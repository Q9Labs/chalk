# Slice 3: Audio

Follow one Participant's microphone through capture, publication, forwarding, reception, and playback. This slice tells apart a microphone that never started and audio that arrived but never played. Transport establishment belongs to [slice 2](README.md).

## 1. Scope

- The TypeScript client owns capture, the local microphone and publication, and remote audio reception. React owns the playback element and the speaking and mute indicators.
- Sync owns the decision to stop a Participant's microphone. The client also records when it applies that decision. These are different witnesses.
- Chalk SFU sees ingress and subscriber egress. Cloudflare Realtime does not expose these per-track packet witnesses to the application. Endpoint evidence cannot distinguish loss inside a managed SFU from loss on either network leg.
- The Go API validates the audio event carried by SDK telemetry. The delivery ledger and the diagnose kernel stay shared.

## 2. Symptom catalogue

| Code | Party | Severity | User words |
| --- | --- | --- | --- |
| `audio.not_heard` | Sender | High | “They can't hear me” |
| `audio.cant_hear` | Listener | High | “I can't hear them” |

## 3. Witnesses

The registry owns the vocabulary. Each of these witnesses describes only what the emitter can see.

| Hop | Witness | What it does not prove |
| --- | --- | --- |
| Device and capture | An audio capture request uses the default or a selected input. The result names a live audio track, denial, unavailable input, missing track, or another capture failure. | A live track is not proof of speech. |
| Mute and publication | The client records microphone intent, its applied forced stop, the publication result, and outbound RTP progress. It can also see a live input signal without outbound byte progress. The listener records an off projection separately from a stopped subscription. | Intent is not a confirmation. An input signal is not proof of speech, and a published track is not proof of packets. |
| SFU | Chalk SFU records whether each microphone publication gained ingress packets, and whether each microphone subscription wrote RTP. | RTP presence does not prove audible voice. |
| Listener | The client records the pull result, inbound byte progress, and the bound element's playback or autoplay state for the same remote publication. | Successful `play()` alone is not proof of progress or audible hardware output. |
| Surface | The React view records committed speaking and mute indicators, not an inference from transport state. | A speaking indicator is not an audio sample. |

No row contains a device label or ID, SDP, a credential, an RTP payload, or the contents of a device error.

## 4. Rule conditions

`audio.not_heard` applies to a seat that can publish in a media Episode. A terminal capture denial, missing or unavailable track, or failed microphone publication proves the named hop without requiring downstream evidence. A known mute or forced stop is not a fault. A silent Participant with a live track is not a fault. A healthy check needs positive capture, publication, and ingress witnesses; missing stages leave it unchecked.

`audio.cant_hear` applies to any seat in a media Episode with another seat. A failed pull that has not delivered a track names subscription. A blocked element with advancing inbound bytes names autoplay. An active element with advancing time and inbound bytes witnesses browser playback, not what the listener physically heard. A flat counter alone stays unchecked. To locate an RTP break, the downstream flat interval must contain an upstream progress interval for the same publication, allowing for clock uncertainty. The receiver measures at least 20 seconds of continuous flat comparable samples so it can contain an SFU interval. An off projection resets that measurement. Forwarding evidence must name the same listener and sender; a different listener's packets are not a substitute.

Scope observations by Episode, seat, and connection or generation where available. Receiver records also name the remote Participant and a track correlation key. Do not use a row for a different track as evidence for playback. A closed delivery window does not turn an absent observation into success. A positive finding can survive an unavailable, independent upstream witness.

## 5. Boundaries to adopt the kernel at

| Record | Boundary |
| --- | --- |
| Client facts | `MediaDeviceSelection.getUserMedia`, microphone transitions in `space-client/media-controller.ts`, publication in `media/client.ts`, and `AudioReceiveHealth` at the point it measures active remote tracks. The SDK uses one typed telemetry event, mapped by the registry on read through the legacy event adapter. |
| Sync fact | `external_operation_consumer/execution.ex` records a forced stop after the provider operation and the original durable moderation decision both succeed. |
| SFU facts | Ingress at `Session.traceIngress` and subscription egress at `Session.traceMedia`. Keep counters at the packet boundary and emit on the existing reporting loop, not per packet. |
| Surface | React commits the speaking or mute indicators; its audio output reports the result of element play and retry through the existing audio observer. |

## 6. Fault scenarios

| Fault | Healthy control | Expected finding |
| --- | --- | --- |
| Deny microphone permission during an explicit capture. | Permit capture, publish a live microphone, and observe ingress. | `broken audio.not_heard`, sender, `hop=mic_permission module=sdk.audio.capture` |
| Reject playback with `NotAllowedError` on the listener while inbound bytes advance. | Attach the same track and let playback time and inbound bytes advance. | `broken audio.cant_hear`, listener, `hop=autoplay module=react.audio_output` |

The fault test drives the SDK capture and receive observers, then judges the emitted claims through the live row adapter and diagnose kernel. Its fixture supplies the seat and time envelope, plus positive stages outside the injected boundary. Deleting a required witness makes a healthy control unchecked. The receive test also shows that SFU progress for a different track cannot prove a receive failure.

```sh
pnpm --filter @q9labsai/chalk-client exec vitest run src/media/audio-chain.fault.test.ts
node scripts/gates/obs-coverage.mjs
```

The compact Episode view renders the positive fixtures as:

```text
f_1a6c broken audio.not_heard pt_a100("Seat 1") +00:04 hop=mic_permission module=sdk.audio.capture upstream=unknown ev=ev_f100
f_4399 broken audio.cant_hear pt_a100("Seat 2") +00:09 hop=autoplay module=react.audio_output upstream=witnessed ev=ev_f100
```

The SFU loopback proof uses two Pion peers: the receiver must get actual RTP, and the ingress and forwarding records must name the corresponding Participants and the same publication.

```sh
cd features/media/sfu
go test -run '^TestMicrophoneObservationsFollowLiveRTP$' ./tests
```

Live verdict delivery still needs the shared SDK ledger to supply the canonical seat and calibrated time envelope, and Sync to export its kernel signal. The fixture envelope is not proof of those paths.

## 7. Out of scope and traps

- Do not treat packet flow or an audio level threshold as speech recognition, or playback progress as proof of a functioning speaker.
- A local mute, a remote projection that is off, and a server-forced stop are distinct.
- Screen-share audio is part of slice 5. Recordings and rendered playback are part of slice 10.
- An older client or an unavailable provider witness stays unchecked. This slice does not schedule any checks or change media behavior.
