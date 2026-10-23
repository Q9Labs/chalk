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
