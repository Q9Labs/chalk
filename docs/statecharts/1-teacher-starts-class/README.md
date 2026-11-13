# Flow 1: a teacher starts a class

A person presses Start call on the home page and lands in a call. `StartClass.tla` is the TLA+ model, `StartClass.cfg` lists the rules TLC checks, `StartClass.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `StartClass.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart StartClass.tla --config StartClass.cfg --view StartClass.view.mjs --out OUT
```

## Rules that break

- **The person who starts a call can end it for everyone.** Path: Start call, the call is created, the video connects, "In the call, no host powers". The public path joins the starter as `collaborator` (`apps/api/internal/publicinviteapp/access.go:149`). That role has no `endEpisode` (`apps/api/db/queries/spaces.sql:95-101`, only `owner` has it at lines 83-93), and the call screen shows End call for everyone only when `useCan("endEpisode")` is true (`sdks/typescript/react/src/components/chalk/Chalk.tsx:280`). So a Start call call ends only by its time limit. Traced against the code, not run.
- **One press of Start call, retried after a failure, still means one call.** Path: Start call, the call is created but the answer never arrives, Start call again, the call is created. The web builds a new request key on every press (`apps/web/src/lib/chalk-access.ts:50,127`) and the API creates a Space for each key (`apps/api/internal/publicinvites/service.go:819`). The first Space stays empty until its lease and linger run out. Traced against the code, not run.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It covers the public Start call path only. Automatic recording is not part of that path (the public Space has no recording policy), so flow 4 covers it. It leaves out the pre-join device step and the sign-in path.
