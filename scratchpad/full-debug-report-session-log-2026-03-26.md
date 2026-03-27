## 2026-03-26 18:45 PKT

- Goal: replace shallow error-dialog support payload with full client-side debug export in ChalkWeb
- Decision: collect in-memory runtime evidence only; no backend dependency for copy/download flow
- Architecture:
  - shared `sdk-core` debug collector for wide-events, incidents, breadcrumbs, plus app-fed logs
  - `apps/web` runtime monkeypatches for `fetch`, `WebSocket`, `console`, `error`, `unhandledrejection`
  - session bridge in `WebChalkRuntime` registers active Chalk session snapshots for report assembly
  - error dialog owns `Copy Full Debug` + `Download JSON`
- Constraint called out to Hasan before implementation: browser can only export JS-visible state; `HttpOnly` cookies and pre-instrumentation traffic remain unavailable

## 2026-03-26 20:40 PKT

- Clipboard follow-up:
  - root cause on main modal/PiP path was promise-backed `ClipboardItem` + rebuilding report during click; browser logged success without proving system clipboard changed
  - secondary bug: optional-chained `writeText` path could report success even when API was unavailable
- Fixes:
  - prebuild debug payload before click in `DiagnosticErrorSheet` + PiP error overlay
  - copy prebuilt plain text with `writeText` first, then `execCommand`, then direct `ClipboardItem` fallback
  - no auto-download on copy failure; dedicated download button added
  - debug log now reports preparation state, failed strategies, and verification mismatch
  - best-effort clipboard read-back verification added after `writeText` when browser allows `readText`
- Verification:
  - `bun run test --filter=@q9labs/chalk-react` passed
  - `bun run test -- src/lib/debugReport.test.ts` passed in `apps/web`
  - `bun run check-types` passed
  - agent-browser headless click on shared helper now reports honest clipboard permission denial instead of fake success; useful as negative-path proof
## 2026-03-27 12:49 PKT

- user repro: `Copy Full Debug` still says copied; clipboard unchanged
- user log: only `document.execCommand(copy)` attempt, `ok: true`
- root cause: helper trusted `execCommand` success without proving clipboard changed
- fix:
  - reorder copy strategies to prefer `navigator.clipboard.writeText()` first
  - keep `ClipboardItem` next
  - run `execCommand(copy)` last
  - only trust `execCommand(copy)` when clipboard read-back matches
  - keep manual copy textarea fallback when all programmatic strategies fail
- tests added:
  - async clipboard wins before exec fallback
  - `execCommand(copy)` false-positive with stale clipboard now fails
- browser verify:
  - forced real web error dialog via `window.__chalkShowError(...)`
  - confirmed real UI path renders `Copy Full Debug`
  - agent-browser clipboard read/write permissions blocked, so system clipboard read-back could not be proven there
