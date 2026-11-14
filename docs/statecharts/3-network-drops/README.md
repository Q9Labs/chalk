# Flow 3: the network drops mid-class and recovers

A student's connection drops, or their device goes to sleep, and the call has to take them back. `NetworkDrops.tla` is the TLA+ model, `NetworkDrops.cfg` lists the rules TLC checks, `NetworkDrops.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `NetworkDrops.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart NetworkDrops.tla --config NetworkDrops.cfg --view NetworkDrops.view.mjs --out OUT
```

## Rule that breaks

- **The "You left" screen shows only to a student who pressed Leave.** Path: the device goes to sleep, 2 minutes pass and the server gives up the seat, the device wakes up, "You left (you did not press Leave)". When a seat lease runs out, `expireEpisodePresence` queues the same `participant_leave` operation as a pressed Leave (`apps/api/internal/adapters/postgres/participant_presence.go:65-110`), and the event reason defaults to `left` (`apps/sync/lib/chalk_sync/episodes/reducer.ex:421`). On wake the client reads its own `participant_left` and turns it into `participant_inactive` (`sdks/typescript/client/src/sync/v1-client.ts:577-580`). `settleTerminalSnapshot` then goes to `left` (`sdks/typescript/client/src/connection/lifecycle.ts:967-975`), and `apps/web/src/components/space/SpaceCall.tsx:134` shows "You left <call>" (`sdks/typescript/react/src/components/chalk/StatusSurface.tsx:30`). Traced against the code, not run.

The mute rule holds in the model: a microphone the student turned off stays an owed "off" until Sync shows it off (`sdks/typescript/client/src/space-client/media-controller.ts:49-62`). The model repeats those rules, so it cannot find a bug in the rules themselves.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It leaves out the stage where Sync is back but the video is still reconnecting, the episode ending while the student is away, and the Rejoin button. When the page stays awake the recovery clock stops at 60 seconds, 60 seconds before the server clock, so "Connection lost, seat still held" lasts up to a minute and only Rejoin gets the student back.
