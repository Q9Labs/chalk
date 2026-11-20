# Slice 7: Access, reconnection and background

This slice explains a connection that stops working after entry to an Episode. Slice 2 owns first entry and first media. Slice 8 owns Leave, intentional End, and rejoin. This slice owns `access.`, `reconnect.` and `background.`. It uses C1 for typed observations, C2 for seat-bound readings, C3 for delivery, and C4 for findings.

## 1. Scope

**Journey.** The SDK maintains access, Sync contact and the SFU transport while a Participant is in an Episode. Web visibility and Page Lifecycle events and native AppState can interrupt the journey without ending it. Sync's presence lease is separate from the SDK connection and the media credential.

**Population.** Episode seats, including listen-only seats. The declaration comes from the Episode authority, not telemetry. A seat that never reaches a checkpoint has incomplete evidence. A media connection whose peer never opened supplies no positive transport witness. An idle provider session, or a silent remote microphone, is not proof that media is dead.

**Files owned.**

- SDK: In `sdks/typescript/client/src/`, the connection lifecycle, its platform ports, and `connection/continuity.ts` own the checkpoints. The Sync client and link watch supply contact evidence. The telemetry outbox, priority table and web platform deliver the observations. `sdks/typescript/react-native/src/space-client/create-native-space-client.ts` wires the same Sync witness to native. The native outbox already receives AppState.
- Sync: `apps/sync/lib/chalk_sync/stateholder/postgres/presence.ex` and `apps/sync/lib/chalk_sync/stateholder/postgres.ex`. Keep presence renewals serialized with removal.
- Delivery: `apps/api/internal/sdktelemetry/` and its generated contract, only for the bounded SDK event payload.
- Formal: `tools/formal/client-recovery/anchors` tracks the refresh guard. The observation does not change the modeled transitions.
- Rules and proof: `observability/registry/areas/access.json`, one rule, fixture pair and runtime fault scenario per symptom, and the diagnose example world and goldens.

## 2. Symptom catalogue

| Code                        | User report                         | What the finding proves                                                                                                                                                                                |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `access.connection_lost`    | “I got kicked out.”                 | A refresh failed and the SDK failed the connection because the grant was no longer usable. It does not infer why the issuer stopped renewing it.                                                       |
| `reconnect.dead_live`       | “It froze and never came back.”     | The current Sync transport is still advertised live after its hard watchdog handled an unanswered ping, or media still advertises live after processing a hard peer failure without starting recovery. |
| `background.resume_stalled` | “I came back and it stayed frozen.” | After a recorded suspend and return, the current connection reached a hard dead-live checkpoint or exhausted transport recovery before a witnessed return to live transports.                          |

Transport exhaustion and an explicit recovery attempt are context, not proof of an abandoned recovery. A transport that reconnects but does not deliver audio or video needs the packet and render witnesses of slices 3 and 4.

## 3. Witnesses

| Fact                      | Checkpoint and source                                                                                                                                                         | Evidence that does not count                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `access.grant_check`      | The SDK access refresh completion in the lifecycle actor. A usable grant, a retry before expiry, expiry or invalid access.                                                    | A status code copied from an API response is not a second, independent witness.                                      |
| `reconnect.sync_check`    | Sync's short ping and pong pair, or its 60-second unanswered-ping watchdog paired with the transport's advertised phase after recovery dispatch.                              | A cached projection, WebSocket ready state, or a buffered, late pong.                                                |
| `reconnect.media_check`   | A current WebRTC connection-state sample and the SDK's media phase and queued recovery for the same client instance.                                                          | A new peer with no ICE, a replaced peer's callback, or an absence of packets. Connected ICE does not prove playback. |
| `background.resume_check` | SDK transport evidence after observed hidden or background, or freeze, and return.                                                                                            | No return report, a missing process, tab discard, or a reply to a ping sent before return.                           |
| `access.presence_renewal` | Sync's committed Participant lease write, including whether the same generation had lapsed, or an authoritative no-op if the Episode or generation no longer permits renewal. | A ping, or a successful renewal of only the Episode's lease. A lease lapsing is not proof of removal.                |

## 4. Rule conditions

Judge the positive failure evidence first, even if another witness is missing. Pass only with explicit usable-grant, fresh-link or resumed-link evidence as appropriate, and a sealed window from the kernel. Missing witnesses, unprobed transports and unresolved resumes stay unchecked. A seat with no resume must not be called a successful resume.

A dead-live finding identifies the checkpoint where observed transport state diverged from advertised state. A confirmed hard failure followed by an advertised recovery is not dead-live. Do not infer an SFU fault, missing presence write or device fault from that divergence.

## 5. Boundaries to adopt the kernel at

- Record a fact at the SDK refresh settlement, the Sync contact or hard watchdog checkpoint, and the media state owner after it handles the current snapshot. Record resumes from this same evidence, not from visibility alone. Keep the existing diagnostics for ICE restart and full media replacement.
- Record a Sync presence fact after the committed transaction. Do not report a renewal when no Participant lease row was updated.
- Send only enum labels through the existing SDK outbox. The API retains authority over the seat. No credential, signaling payload, exception text or client-provided Participant ID crosses the event wire.

## 6. Fault scenarios

| Code                        | Fault and healthy control                                                                                                                                                                                                               | Diagnose contract                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `access.connection_lost`    | Stop grants from renewing through expiry. Allow renewal in the control.                                                                                                                                                                 | `access.connection_lost` broken for the affected seat, `module=sdk.connection`, `hop=access_refresh`.  |
| `reconnect.dead_live`       | Keep a failed peer advertised live with no recovery. For the control, provide fresh Sync contact and a connected peer. Also exercise an unanswered Sync ping with the recovery path intact and a late pong that does not prove contact. | `reconnect.dead_live` broken for the affected seat, `module=sdk.connection`, `hop=transport_liveness`. |
| `background.resume_stalled` | Suspend and return while the peer is dead but still advertised live. For the control, return with a fresh contact and connected peer.                                                                                                   | `background.resume_stalled` degraded for the affected seat, `module=sdk.connection`, `hop=resume`.     |

Run `pnpm --dir sdks/typescript/client exec vitest run src/connection/continuity.fault.test.ts src/sync/v1-client.test.ts` to exercise the lifecycle, transport watchdog and telemetry outbox. Capture the emitted fields and judge them through the row adapter and kernel. A synthetic network or media adapter can inject faults, but it cannot prove browser freezing, native suspension, a provider binding's expiry, or persisted delivery on a live stack. Run those live controls separately before claiming deployed coverage.

The legacy SDK telemetry upload carries event IDs, sequence and monotonic elapsed time but not a server-time estimate. The current ingest path logs a hashed Participant ID, not the canonical seat ID the live proof reader requires. Until the foundation preserves seat identity and calibrated time through durable ingest and readback, use the fixture envelope only for the SDK fault scenarios. Do not equate upload time with event time. Sync also needs an exporter for kernel records.

## 7. Out of scope and traps

Do not touch initial entry, intentional end, track-level continuity, or rejoin. Do not shorten timeouts, change recovery, extend leases, or add a scheduled checker to get a witness. A grant can be usable while its media binding is dead. A transport can be connected while no track resumes. A frozen or killed process cannot observe its own absent work. Report those distinctions rather than collapsing them into “connection lost.”
