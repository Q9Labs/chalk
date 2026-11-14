# Flow 1: a teacher starts a class

A person presses Start call on the home page and lands in a call. `StartClass.tla` is the TLA+ model, `StartClass.cfg` lists the rules TLC checks, `StartClass.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `StartClass.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart StartClass.tla --config StartClass.cfg --view StartClass.view.mjs --out OUT
```

## Rules that hold

`StartClass.broken.cfg` runs the old code, and TLC reports both rules broken there.

- **The person who starts a call can end it for everyone.** The public path joins the starter as `owner` (`PublicRoleOwner` in `apps/api/internal/publicinvites/service.go`, `CreatePublicSpace`). Only `owner` has `endEpisode` (`apps/api/db/queries/spaces.sql`), so End call shows for the starter. Before the fix the starter joined as `collaborator` and a Start call call ended only by its time limit.
- **One press of Start call, retried after a failure or pressed twice, still means one call.** The web keeps one request key per Start call until the call is created (`createPublicSpace` in `apps/web/src/lib/chalk-access.ts`), and the API makes one Space for one key. Before the fix every press made a new key and so a new Space. The model covers the retry after a lost answer. A double press while the first request runs sends the same key too, and `apps/web/src/lib/start-call-idempotency.test.ts` checks that.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It covers the public Start call path only. Automatic recording is not part of that path (the public Space has no recording policy), so flow 4 covers it. It leaves out the pre-join device step and the sign-in path.
