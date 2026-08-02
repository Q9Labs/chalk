# Chalk join-path observability

## Concept

Give Chalk the same useful property as the BAML trace view: after a meeting join runs, the system should explain its execution in the same shape as the code that produced it.

The product idea is a bounded, privacy-safe join trace. It records each meaningful boundary, preserves the parent/child relationship between steps, measures where time was spent, and makes the terminal reason explicit. A failed join should answer “which branch failed and what was still cleaned up?” without requiring a user to reproduce the whole flow from logs.

## Chalk’s join path

The public meeting surfaces create a `ChalkSession`; the session owns the actual join orchestration:

```text
VideoConference / MobileMeetingScreen
  -> ChalkSession.join()
    -> #performJoin()
      -> #acquireInitialMedia()
      -> access.initialize()
      -> createMediaClient()
      -> createSyncClient()
      -> subscribe lower layers
      -> media.start(stream)             ┐
      -> sync.start()                    ├─ parallel startup
        -> #waitForSyncLive()
      -> state = live
```

The failure path is equally important: a stale epoch or startup error tears down lower layers, records whether cleanup was confirmed, and resolves to a typed `ChalkSessionError`.

## Trace shape

Every join trace uses a root `join` span and bounded child steps:

| Step                    | What it answers                                      |
| ----------------------- | ---------------------------------------------------- |
| `acquire_initial_media` | Did permission and local track setup complete?       |
| `access_initialize`     | Did Chalk obtain participant access?                 |
| `create_media_client`   | Did the media-plane client construct?                |
| `create_sync_client`    | Did the Sync client construct?                       |
| `start_media`           | How long did media startup take?                     |
| `start_sync`            | How long did the Sync transport startup take?        |
| `wait_for_sync_live`    | How long until Sync reached the required live state? |

Each span records only:

- a stable local span id and optional parent span id;
- step name, `started`/`succeeded`/`failed`/`cancelled` outcome;
- duration when the step ends;
- session state, join epoch, and a typed error code when available.

It does not record raw media, tracks, access tokens, participant identity, room identity, SDP, or request bodies.

## Chalk implementation

The core `ChalkSessionDiagnostics` timeline now emits `join_span` start/end events and exposes a filtered `getJoinTrace()` view for trace-oriented tooling. The timeline remains bounded by the existing diagnostics limit, so instrumentation cannot grow without limit or change session behavior.

React Native forwards these events through the existing `diagnostic.timeline` journey event with the span metadata as bounded attributes. That keeps the join path correlated with the existing W3C journey, HTTP, Sync, and RTC telemetry while preserving the current terminal meeting journey lifecycle.

## Revisit direction

The next UI can consume `session.getJoinTrace()` and render the same four useful views as the reference concept: a run timeline, a hierarchy/graph, a selected-span detail panel, and a flame/waterfall view. The data contract is deliberately small enough for a web diagnostics drawer, a mobile developer panel, or an API-side trace explorer to share.
