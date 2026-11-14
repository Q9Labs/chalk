# Flow 4: the class ends and the recording is finalised

A recorded class runs, then the host ends it or the time limit arrives, and the recording is built. `ClassEnds.tla` is the TLA+ model, `ClassEnds.cfg` lists the rules TLC checks, `ClassEnds.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `ClassEnds.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart ClassEnds.tla --config ClassEnds.cfg --view ClassEnds.view.mjs --out OUT
```

## Rules

No rule breaks. Three hold: when the call has ended nothing is still recording it live, the recording is built only after the class ended, and an ended call never runs again. They hold because `episode_ended` empties the room and clears the live recording in one event (`apps/sync/lib/chalk_sync/episodes/reducer.ex:592-607`, `valid_state?` at 612-632), and the ended event is written only after the end cleanup succeeds. A failed end puts the class back to running (`apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex:1093`), so participants see the class keep running until the end succeeds.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It merges "the host presses End" and "the time limit arrives" into one arrow. It leaves out the host extending the time (a late extension makes the old deadline stale, `stale_maximum_duration?` in the finalizer), the capture retries before the end (10 attempts), the transcript, and who can press End: only an owner can, and a Start call starter is an owner (see flow 1).
