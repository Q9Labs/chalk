# Flow 2: a student joins

A student opens an invite link, waits for the host when the room needs approval, joins, and may reload the page in the call. `StudentJoins.tla` is the TLA+ model, `StudentJoins.cfg` lists the rules TLC checks, `StudentJoins.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `StudentJoins.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart StudentJoins.tla --config StudentJoins.cfg --view StudentJoins.view.mjs --out OUT
```

## Rule that breaks

- **A student who waits for the host is let in or declined by the host, and is not turned away because the host made entry easier.** Path: Join, waiting, the host opens the room to everyone, "Request expired, the host just opened the room". On the next status poll `ArrivalStatus` finds the request still pending, then `pendingGuestArrivalValid` returns false because `space.AdmissionMode != AdmissionKnock` (`apps/api/internal/publicinvites/service.go:1181-1196`, `1291-1294`). The arrival becomes `unavailable` and the web shows "Your request to join expired or is no longer available." (`apps/web/src/components/space/SpacePage.tsx`, `neutralMessage`). Nothing invalidates or approves pending requests when the mode changes. The student can press Join again and enter the open room. Traced against the code, not run.

## What the chart hides and leaves out

It hides two steps: the video connection failing while joining, and a reload after the 2 minute marker expired. Both end on the invite link screen. It leaves out the knock request list on the host side, the sign-in identity path, and the second tab case beyond the refused old seat.
