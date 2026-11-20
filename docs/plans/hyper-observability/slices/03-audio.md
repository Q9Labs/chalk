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
| Mute and publication | The client records microphone intent, its applied forced stop, and the publication result. The listener records an off projection separately from a stopped subscription. | Intent is not a confirmation and a published track is not proof of packets. |
| SFU | Chalk SFU records whether each microphone publication gained ingress packets, and whether each microphone subscription wrote RTP. | RTP presence does not prove audible voice. |
| Listener | The client records the pull result, inbound byte progress, and the bound element's playback or autoplay state for the same remote publication. | Successful `play()` alone is not proof of progress or audible hardware output. |
| Surface | The React view records committed speaking and mute indicators, not an inference from transport state. | A speaking indicator is not an audio sample. |

No row contains a device label or ID, SDP, a credential, an RTP payload, or the contents of a device error.

## 4. Rule conditions

`audio.not_heard` applies to a seat that can publish in a media Episode. A terminal capture denial, missing or unavailable track, or scored publication failure proves the named hop without requiring downstream evidence. A known mute or forced stop is not a fault. A silent Participant with a live track is not a fault. A healthy check needs positive capture, publication, and ingress witnesses; missing stages leave it unchecked.

`audio.cant_hear` applies to any seat in a media Episode with another seat. A terminal pull failure names subscription. A blocked element with advancing inbound bytes names autoplay. An active element with advancing time and inbound bytes witnesses browser playback, not what the listener physically heard. Do not call a receiver stalled from a first stats sample or from a muted projection. If the only available evidence is that RTP did not advance, name the receive boundary without assigning provider blame. Server forwarding evidence must name the same listener and sender; a different listener's packets are not a substitute.

Scope observations by Episode, seat, and connection or generation where available. Receiver records also name the remote Participant and a track correlation key. Do not use a row for a different track as evidence for playback. A closed delivery window does not turn an absent observation into success. A positive finding can survive an unavailable, independent upstream witness.

## 5. Boundaries to adopt the kernel at

| Record | Boundary |
| --- | --- |
| Client facts | `MediaDeviceSelection.getUserMedia`, microphone transitions in `space-client/media-controller.ts`, publication in `media/client.ts`, and `AudioReceiveHealth` at the point it measures active remote tracks. The SDK uses one typed telemetry event, mapped by the registry on read through the legacy event adapter. |
| Sync fact | The provider-confirmed target in `live/episode.ex`. Record a forced stop only after the target succeeds. |
| SFU facts | Ingress at `Session.traceIngress` and subscription egress at `Session.traceMedia`. Keep counters at the packet boundary and emit on the existing reporting loop, not per packet. |
| Surface | React commits the speaking or mute indicators; its audio output reports the result of element play and retry through the existing audio observer. |

## 6. Fault scenarios

| Fault | Healthy control | Expected finding |
| --- | --- | --- |
| Deny microphone permission during an explicit capture. | Permit capture, publish a live microphone, and observe ingress. | `broken audio.not_heard`, sender, `hop=mic_permission module=sdk.audio.capture` |
| Reject playback with `NotAllowedError` on the listener while inbound bytes advance. | Attach the same track and let playback time and inbound bytes advance. | `broken audio.cant_hear`, listener, `hop=autoplay module=react.audio_output` |

Run both pairs against runtime entry points with captured rows fed to the diagnose judge. Exercise the same boundaries in a real two-Participant call before claiming end-to-end delivery proof. Verify that removing a required witness from a healthy control makes it unchecked and that removing an unrelated upstream witness does not erase either proven failure.

## 7. Out of scope and traps

- Do not treat packet flow or an audio level threshold as speech recognition, or playback progress as proof of a functioning speaker.
- A local mute, a remote projection that is off, and a server-forced stop are distinct.
- Screen-share audio is part of slice 5. Recordings and rendered playback are part of slice 10.
- An older client or an unavailable provider witness stays unchecked. This slice does not schedule any checks or change media behavior.
