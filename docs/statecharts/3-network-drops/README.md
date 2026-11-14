# Flow 3: the network drops mid-class and recovers

A student's connection drops, or their device goes to sleep, and the call has to take them back. `NetworkDrops.tla` is the TLA+ model, `NetworkDrops.cfg` lists the rules TLC checks, `NetworkDrops.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `NetworkDrops.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart NetworkDrops.tla --config NetworkDrops.cfg --view NetworkDrops.view.mjs --out OUT
```

## Rules that hold

- **The "You left" screen shows only to a student who pressed Leave.** When a seat lease runs out, the server queues the same `participant_leave` operation as a pressed Leave, so the client cannot tell the two apart from the event. It tells them apart by its own state: `settleTerminalSnapshot` (`sdks/typescript/client/src/connection/lifecycle.ts`) sets `timedOut` when the student's own `participant_left` arrives while the student is still in the call. A pressed Leave moves the client to `leaving` first, so it never sets `timedOut`. The web then shows "You were disconnected from <call>" with a Rejoin button (`timed-out` in `sdks/typescript/react/src/components/chalk/StatusSurface.tsx`). `NetworkDrops.broken.cfg` runs the old code, where the same path ended on "You left", and TLC reports `LeftOnlyWhenYouLeave` broken there.

The mute rule holds in the model: a microphone the student turned off stays an owed "off" until Sync shows it off (`sdks/typescript/client/src/space-client/media-controller.ts:49-62`). The model repeats those rules, so it cannot find a bug in the rules themselves.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It leaves out the stage where Sync is back but the video is still reconnecting, the episode ending while the student is away, and the Rejoin button. When the page stays awake the recovery clock stops at 60 seconds, 60 seconds before the server clock, so "Connection lost, seat still held" lasts up to a minute and only Rejoin gets the student back.
