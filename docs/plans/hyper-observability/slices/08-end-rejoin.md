# Slice 8: Call end and rejoin

This slice extends [the slice contract](README.md) and section 9 of the [hyper-observability plan](../../hyper-observability.md#9-how-the-work-splits-no-phases).

## 1. Scope

The journey starts when a Participant leaves, a host removes them, the Episode ends, or Sync closes for a deploy. It ends when the Participant sees the resulting state and, if they choose Rejoin, the Space starts a new arrival. Leave and removal end one seat; Episode end ends all seats. Sync drain is a transport close, not Episode end or removal. A recovered socket keeps its seat; a new arrival may receive a new seat and may enter a new Episode in the same Space.

The checks judge an Episode. Episode end is item-wide. The SDK terminal classification and the prerequisite release of the previous web arrival are judged per seat. A new arrival's invite, wait, admission and join are entry and join witnesses; an absence on the old seat cannot prove that the new arrival succeeded or failed.

## 2. Symptom catalogue

| Code | Meaning | Party |
|---|---|---|
| `end.wrong_screen` | The client classified an authoritative end as a connection failure, or misclassified a maximum-duration end. | Previous seat |
| `end.time_limit` | The Episode ended at its maximum duration. This is expected, not an outage. | All |
| `rejoin.refused` | The web app could not release the previous arrival and therefore did not start the new arrival. | Previous seat |

## 3. Witnesses

| Fact | Boundary |
|---|---|
| `end.episode` | The reason Sync reads from the finalized Episode row. |
| `end.client_screen` | The SDK's terminal classification; its legacy name is retained on the telemetry wire. This is a decision, not independent evidence that pixels rendered. |
| `rejoin.release` | The previous arrival's release result, emitted only on explicit Rejoin. A successful result proves that release, not the successor admission. |

Use the authenticated previous seat to attribute release. Do not join the two seats by display name. No fact contains an invite, access token, raw transport reason, or release error text.

## 4. Rule conditions

- `end.wrong_screen` retains the existing 10 s before / 120 s after comparison around the server end. Failure classifications in that interval are wrong. When the client knows the specific reason, compare it with the required classification too: `maximum_duration` must be reported as `time_limit`. An intentional Leave, removal, or page close is not a disagreement. A status-only confirmation from older servers can have no reason and show the generic end screen.
- `end.time_limit` requires a witnessed end. It reports `expected` for `maximum_duration` and passes another authoritative reason. It does not suppress a separate, proven wrong screen.
- `rejoin.refused` reports a witnessed failed release even if a later retry works. A witnessed successful release passes if the evidence is complete and no failure was seen. A seat with no terminal release result is not declared a healthy rejoin; no click is inferred from an absent event.
- An absent required terminal witness cannot pass. Do not infer an Episode end from a socket closing, or infer a deploy caused a failed client from coincident timestamps.

## 5. Kernel boundaries

- Sync: keep the linked observation at `stateholder/postgres/webhook_observation.ex`, and emit the typed fact only after the finalized row is visible.
- SDK: classify from the Sync control reason in `connection/telemetry.ts`; `connection/lifecycle.ts` owns terminal publication. Keep the existing durable SDK outbox and its legacy projection instead of adding a second transport.
- Web: `SpaceCall.tsx` owns the old arrival release. `SpacePage.tsx` invokes the observed release on Rejoin before creating the new arrival. Other cleanup must not be counted as a Rejoin.
- Existing UI owners use `sessionExit` and `callEndNotice`; they do not interpret the telemetry label as a Sync reason.

## 6. Fault scenarios

Extend `end-wrong-screen.fault.test.ts` through the real SDK lifecycle. Drop the terminal notice and return stale status during a media rejection to witness a failure screen. As a control, confirm the Episode end from the current status. Drive a terminal Sync snapshot with `maximum_duration` to reproduce the mapping defect; require the same terminal render reason and one `time_limit` record after the fix. Use another authoritative reason as the healthy control for `end.time_limit`.

For `rejoin.refused`, make the previous arrival release fail during an explicit Rejoin. The entrance stays ended, the next arrival is not created, and the witness names the previous seat. Retry with a successful release and check that a new arrival starts. Exercise intentional Leave, removal, and a 1012 deploy close separately: Leave and removal should not read as Episode end, and a recovered 1012 close should produce no terminal record.

Against the non-production stack, run `node .agents/skills/verify-chalk/scripts/start-call.mjs <run-id> --fault-rejoin`. Chromium injects HTTP 503 on the old arrival's DELETE, witnesses the failed release POST, clears the fault, and verifies that retry rejoins the same Space. Run `call-length.mjs <run-id>` in the same harness to drive the deadline and observe both the time-limit and host-end screens.

Finding line shapes (handles and times come from the run):

```text
f_x broken end.wrong_screen pt_x +60:00 hop=client_end module=sdk.connection upstream=witnessed ev=ev_x
f_x expected end.time_limit all +60:00 reason=end.time_limit ev=ev_x
f_x broken rejoin.refused pt_x +02:10 hop=release module=web.space_entry upstream=unknown ev=ev_x
```

## 7. Out of scope

No new reconciliation policy, deploy detector, client credential, or scheduled checking. The SDK path proves the terminal classification; a real browser run is needed to prove rendering. Media outages and transport recovery belong to slice 7; the successor admission belongs to slices 1 and 2.
