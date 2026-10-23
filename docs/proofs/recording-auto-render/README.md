# Expired recording browser proof

These contact sheets compare the real web page with fixture API responses on
the Apple M4. The left side uses PR #384's page at
`fa7c6eef5b4b581230d8e236be518f31fdd02b0e`; the right side includes this fix.
Both receive a retained capture, an expired render, its deadline reason, and a
transcription source that is ready to use.

- [Desktop, 1440 pixels](expired-desktop.png)
- [Mobile, 390 pixels](expired-mobile.png)

The browser checks reject a spinner, preparation or retry action for this
expired render, and require its reason and the independent transcript action.
The added scenario fails before the fix at both sizes and passes afterwards.

The fixture run also covers capture failure, expired source, render failure,
transcript failure, polling, playback and download. It does **not** prove a real
two-person call through API, Sync, capture and render workers. The separate
three-minute M4 compositor measurement uses synthetic media, not a real call.

## Tenant recording preference

The existing Developer page now has a recording preference. No new settings page
was added. Every existing and new Tenant defaults to `on_demand`; only an explicit
`automatic` preference queues an MP4 when capture completes.

[Before / after, laptop](developer-before-after.png) compares the page at
`eb36957252bbe9eab9edd1f75424b9ed58eaa7c1` with the new default control.
[Saved automatic mode, laptop / phone](developer-responsive.png) shows the saved
control at 1440 and 390 pixels. [Before recording](developer-before.webm) and
[after recording](developer-after.webm) show the browser workflow.

These runs used the real web page on Instabox with dashboard DTO fixtures,
not a production account. The scripted checks verify the default, save/reload,
failed-save recovery and switching back to on demand. Run them with:

```sh
DASHBOARD_DEVELOPER_ONLY=1 CHALK_DEV_WEB_PORT=4031 FIXTURE_PORT=4032 node apps/web/tests/dashboard-ui/run.mjs
```

`TestCaptureCompletionRenderMode` separately uses PostgreSQL and an in-memory
OpenTelemetry span recorder. It checks on-demand export, automatic queueing,
rollback of both job and journey, replay without duplication, and a durable
`recording.render.queued` event linked to the exported completion span.
`TestTenantRecordingRenderHTTPPersistence` checks the real HTTP API, database
persistence, invalid input, service ownership and write scopes. The dashboard
real-engine suite exercises the dashboard handler through the generated client
to the real API and database, including account isolation.
