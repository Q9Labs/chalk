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
