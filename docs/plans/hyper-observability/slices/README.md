# Slice specs

Each file here is the spec for one vertical slice of the [hyper-observability plan](../../hyper-observability.md) (section 9). A slice adopts the observability kernel in its own modules and owns its registry entries, symptom codes, rules, fixtures, fault scenarios and CLI section. The four foundation contracts (C1 IDs and envelope, C2 witnesses and verdict, C3 delivery, C4 CLI output) are locked before any slice starts. The specs were written against the plan's names; where a contract landed with a different name, the contract wins and the spec's meaning stays.

| # | Slice | Spec | Built by | Symptom prefixes it owns |
|---|---|---|---|---|
| 1 | Entry: dashboard, invite, admission, prejoin, embed, boot | [01-entry.md](01-entry.md) | SWE-2 | `boot.` `embed.` `invite.` `admission.` `prejoin.` `dashboard.` |
| 2 | Join and media connection, listen-only | (Opus) | Opus | `join.` `media.` |
| 3 | Audio chain | (Opus) | Opus | `audio.` |
| 4 | Video | [04-video.md](04-video.md) | SWE-2 | `video.` |
| 5 | Screen share | [05-screen-share.md](05-screen-share.md) | SWE-2 | `share.` |
| 6 | Whiteboard | (Opus) | Opus | `board.` |
| 7 | Access, reconnection, background | (Opus) | Opus | `access.` `reconnect.` `background.` |
| 8 | Call end and rejoin | (Opus) | Opus | `end.` `rejoin.` |
| 9 | Crashes and performance, web and native | [09-crashes-performance.md](09-crashes-performance.md) | SWE-2 | `page.` `app.` `perf.` |
| 10 | Recording and rendering | [10-recording.md](10-recording.md) | SWE-2 | `recording.` `render.` `playback.` |
| 11 | Transcription | [11-transcription.md](11-transcription.md) | SWE-2 | `transcript.` |
| 12 | Webhooks and tenant integration | [12-webhooks-integration.md](12-webhooks-integration.md) | SWE-2 | `webhook.` `integration.` |
| 13 | Report a problem and live introspection | [13-report-live.md](13-report-live.md) | SWE-2 | `report.` `live.` |
| 14 | Platform: DB, releases, flags, Cloudflare edge | [14-platform.md](14-platform.md) | SWE-2 | `db.` `release.` `flags.` `edge.` |

A slice never defines a code under another slice's prefix. When a symptom belongs to another slice, the spec names that slice and the builder leaves it alone.

## Words every spec uses

- **Verdict fields (C2).** `outcome` is `broken`, `degraded`, `expected` or `healthy`. `coverage` is `complete`, `partial(<source>)` or `unchecked`. `disagreement` is a list of witness conflicts. They are three separate fields: never fold one into another.
- **Backstops (C2).** `UNEXPLAINED` (a failed outcome no rule claims), `BLIND_SPOT` (a problem report on an Episode judged healthy), `WITNESS_DISAGREEMENT` (two witnesses contradict), `UNCHECKED` (nobody ran the checker yet). A slice rule never emits these itself; the checker does.
- **Three-state values (C2).** `observed(v)`, `unavailable(reason)`, `not_applicable`. A missing number is never `0`, `""` or `"unknown"`.
- **Kernel calls (C1).** `op(name, fn)` with exactly one terminal `ok`, `expected(code)` or `error(code)`; `transition(machine, from, to, trigger, reason)` at the existing state owner; `decision(name, outcome, reason_code, inputs)` at the authoritative commit; `surface(name, state, reason)` at committed display, through `<ObservedSurface>` in web and React Native; `fact(name, fields)` for measurements.
- **IDs (C1).** Display handles come only from `formatHandle(kind, id)` and are parsed only by `parseHandle(text)`. Prefixes: `ten_ spc_ ep_ pt_ usr_ agt_ dev_ cs_ mc_ sc_ jr_ rec_ job_ whd_ dg_` (`dg_` is a diagnostic upload, slice 13, which C1 adds), findings `F-xxxx`, report codes `CHK-XXXX`. Never write a prefix by string concatenation.
- **Delivery (C3).** `evidence_gap` marks a source that stopped with an unknown tail. A source watermark says how far a source is known complete.
- **Witness sources.** `client` (SDK, web or mobile event), `api` (API request log or decision), `sync` (Sync span or log), `sfu` (Chalk SFU journal or stats), `cf` (Cloudflare Realtime provider response), `recorder`, `lambda`, `provider_webhook`, `db` (a Postgres row), `r2` (an object or its readback), `host` (worker host or systemd log), `edge` (Cloudflare Worker edge log), `report` (a problem report), `release` (a CI or deploy-script release marker, slice 14; the lead adds it to C2's list). Two sources are independent only when neither one copies its value from the other. A client event that logs the code the API sent back is the same decision as the API's log, not a second witness.
- **Coverage strings (C2).** `partial(<source>)` names a source from the list above, or `partial(<source>.<part>)` when only one part of it is missing (`partial(client.render)`, `partial(api.request_log)`). Several go in one string, comma-separated with no spaces, in alphabetical order: `partial(client,edge)`. Nothing else goes inside the parentheses, and every name in it gets one `gap:` line.
- **Module names.** `<component>.<area>`, where the component is one of `web`, `react`, `rn`, `sdk`, `mobile`, `ios`, `api`, `sync`, `sfu`, `cf`, `recorder`, `dispatcher`, `postgres`, `storage`, `host`, `tenant`; the area may itself be dotted (`api.webhooks.dispatcher`). `network` and `unknown` stand alone. A module name never starts with a symptom prefix, so `db.`, `edge.`, `release.` and the rest never name a module.
- **Severity.** `high`: a Participant can't take part (no entry, no media, crash, lost artifact), or something they tried to stop showing stays visible to others (a share that won't stop). `medium`: they take part but something they need is wrong or late (frozen video, recording hours late). `low`: cosmetic, or invisible to Participants but visible to operators.

## CLI samples (C4)

Every spec's section 6 prints plan section 8's compact grammar the same way:

- **Line 1:** `<scope> <subject> outcome=<o> coverage=<c> asof=<t> rules=<n>`, where `<n>` is the rules version. Scopes: `episode ep_x`, `attempt cs_x`, `space spc_x`, `day <date> <tz>`, `tenant ten_x <from>..<to>`, `platform <env> <from>..<to>`. C4's anchor line comes second and is left out of the samples.
- **Finding:** `F-xxxx <code> <party> <time> hop=<hop> module=<module>`, then any slice-specific `key=value` fields. `xxxx` is 4 lowercase hex digits. Episode times are relative (`+mm:ss`, minutes may pass 59); other scopes use absolute UTC times. An EXPECTED result is a finding line that adds `outcome=expected reason=<reason_code>` (hop and module may be left out when nothing failed).
- **`fact:`** each observation ends with its source in brackets, `[db]` or `[api,db]`, which is where C4 prints the evidence handle; then `expected ...`, then a watermark `<source> complete to <t>`.
- **`hypothesis:`** only when warranted, with its falsifier. **`gap: <source>[.<part>] <reason>`**, one per name in `partial(...)`, for example `gap: edge unavailable(no_cloudflare)`.

## Recipe for a builder

Do these in order. Each step ends in a check; don't start the next until it passes.

1. **Read the spec twice, then the plan sections it cites.** Open every file:line in the spec. If a line moved, find the same code by name and use the new line. If the code is gone, stop and report it; don't guess a replacement. A path written as `path (new)` is a file your slice adds.
2. **Add the registry entries.** For every symptom and every new event or field in the spec, add the entry in `observability/registry/` the way C1's worked example does, with the empty `sensitivity` slot. Run `pnpm run regen`, then `pnpm run check:generated`.
3. **Adopt the kernel at the boundaries in section 5 of your spec, and only there.** Use the call the spec names (`op`, `decision`, and so on). Keep the existing log line or metric next to it unless the spec says to remove it. A catch you add either rethrows or reports through `obs`.
4. **Write each rule in section 4.** One rule per symptom. Each rule returns `broken`, `degraded`, `expected`, or a gap; it never returns `healthy` by itself, because healthy comes only from the sealed `ProofBundle` (C2). Where the spec says "unknown", the rule returns a gap with the named source, never a pass.
5. **Write two fixtures per rule:** a positive fixture that fires and a healthy fixture that doesn't. Build fixture rows from the real event shapes, not from the rule's own expectations.
6. **Add the CLI section** in `scripts/diagnose-call/` (or the `diagnose` CLI once C4 lands) using C4's compact grammar and `--json` objects. Print the exact lines in your spec's fault table.
7. **Run each fault scenario in section 6** on the real stack (local dev stack or an Orb, as the scenario says). Save the CLI output next to the scenario. Then run the healthy control and save its output too. If the environment a scenario needs doesn't exist, stop and report it; never stand in a fixture for a real run.
8. **Run the gates** for the files you touched (see `scripts/gates/README.md`); heavy ones go to Instabox per AGENTS.md.

## Done bar

A slice is done only when all of these hold:

- Every injected fault in section 6 is diagnosed with the right symptom code, the right Participant (or Tenant, Episode or job when the spec says so) and the right module, with the CLI line the spec gives. Close is not done: a different code, the wrong Participant or `UNEXPLAINED` is a failure.
- Every healthy control raises no finding and no backstop, and its coverage is `complete` or names exactly the gaps the spec expects.
- Deleting any one required witness from a positive fixture turns `healthy` into a gap, never into `healthy`, and never erases a `broken` finding that another witness already proved.
- `pnpm run check:generated` passes, and the coverage-graph check lists every new symptom with its witnesses, rule, both fixtures and fault scenario.
- Nothing outside the slice's section 1 files changed, except registry entries and the CLI section.
