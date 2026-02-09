# Screenshare Research (iOS + Android)

Goal: de-risk screenshare early (highest integration risk) before building UI.

## iOS (ReplayKit Broadcast Upload Extension)

Baseline docs / references:
- RealtimeKit iOS screenshare guide: https://docs.realtime.cloudflare.com/ios-core/local-user/screen-share-guide
  - Note: page is explicitly flagged “being updated”.
- ReplayKit overview: https://developer.apple.com/documentation/ReplayKit

Key reality: iOS screenshare is **not** “just an SDK call”. It’s a **separate app extension target** that captures frames and hands them to the RealtimeKit SDK via an app-group shared channel.

### Required project setup

1) Create extension target
- Xcode → File → New → Target → **Broadcast Upload Extension**

2) App Groups
- Add **App Groups** capability to:
  - Main app target
  - Broadcast Upload Extension target
- Use the **same** group identifier for both (example: `group.com.q9labs.chalk.screenshare`).

3) SampleHandler implementation
- Cloudflare guide expects your extension’s `SampleHandler` to inherit from `RtkSampleHandler`.
- The reference implementation (as used upstream) reads `RTKRTCAppGroupIdentifier` from the extension bundle’s `Info.plist` and writes/reads from a shared container path `.../rtc_SSFD` (UNIX socket / local stream transport).
- Upstream reference file: https://github.com/dyte-io/iOS-ScreenShare (look at `RtkSampleHandler.swift`).

Minimal shape:

```swift
import ReplayKit
final class SampleHandler: RtkSampleHandler {}
```

4) Info.plist keys

Both targets (main app **and** extension) should include:

```xml
<key>RTKRTCAppGroupIdentifier</key>
<string>group.com.q9labs.chalk.screenshare</string>
```

Main app target should include:

```xml
<key>RTKRTCScreenSharingExtension</key>
<string>com.q9labs.chalk.ScreenShareExtension</string>
```

### Start/stop flow (what the app must do)

Apple requires user-driven start. Pattern seen in upstream iOS sample apps:

1) Launch system broadcast picker (and point it at our extension bundle id)
- Use `RPSystemBroadcastPickerView`
- Set `preferredExtension` to the extension bundle id (same value as `RTKRTCScreenSharingExtension`).

2) Call RealtimeKit screenshare enable
- RealtimeKit iOS Core docs mention `meeting.localUser.enableScreenshare()` / `disableScreenshare()`.
- Some RealtimeKit examples use `enableScreenShare()` / `disableScreenShare()` (note spelling/casing differences across SDKs / docs).

3) Stop
- Call RealtimeKit disable AND expect the user can also stop via system UI.

Reference: dyte/Cloudflare iOS sample app code uses `RPSystemBroadcastPickerView` then calls `rtkClient?.localUser.enableScreenShare()` (sample repo: https://github.com/dyte-io/ios-samples).

### Events to wire (MVP)

Use RealtimeKit participant collections/events as the source of truth for “someone is sharing”:
- `meeting.participants.screenShares` (remote sharers)
- Local: `meeting.localUser.screenShareEnabled` (or equivalent)
- Event hook: “screen share update” (API naming differs by platform; see platform docs)

App behavior:
- Only allow local start if preset permissions allow.
- UI: show “sharing” state; show remote screenshare tiles when `participants.screenShares` non-empty.

### Known pitfalls / gotchas

- Doc drift: iOS screen share guide is marked “being updated” → treat as unstable.
- Method name drift: `enableScreenshare` vs `enableScreenShare` in different docs/samples.
- App Group mismatch = silent failure (extension can’t find shared container / socket).
- Extension signing/capabilities must match main app (team id, entitlements).
- Broadcast picker behavior varies by iOS version; keep start action user-driven and resilient.

### Spike checklist (definition of “screenshare works”)

- iOS 16/17/18: start broadcast → remote participants receive screenshare track.
- Stop from app button and from iOS system “Stop Broadcast” UI.
- App background while broadcasting: meeting remains connected (or reconnects cleanly), screenshare doesn’t deadlock.
- Orientation changes don’t permanently freeze frames.

## Android (MediaProjection)

Baseline docs / references:
- RealtimeKit Android Core local user: https://docs.realtime.cloudflare.com/android-core/local-user/introduction
- Android 14+ foreground service type requirements (mediaProjection): https://developer.android.com/about/versions/14/changes/fgs-types-required
- Audio focus + background constraints (Android 15 note): https://developer.android.com/media/optimize/audio-focus

Key reality: Android screenshare is **MediaProjection** under the hood, and on Android 14+ it is gated by **foreground service type + permission** requirements.

### Manifest requirements (Android 14+)

From RealtimeKit docs:
- Declare `android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION`

From Android platform requirements (targetSdk 34+):
- Foreground service must declare `android:foregroundServiceType="mediaProjection"`
- The app must request `FOREGROUND_SERVICE` and the type-specific permission.

Also practical needs:
- `POST_NOTIFICATIONS` (to show foreground service notification on Android 13+)

### Permission + lifecycle flow (must respect order)

Android requirement (important): call `MediaProjectionManager.createScreenCaptureIntent()` **before** calling `MediaProjectionManager.getMediaProjection(...)`. See Android docs above.

Practical (Android 14+ / targetSdk 34+): ensure the capture flow is paired with a foreground service that declares `mediaProjection` type + permission, and start/stop it tightly with the projection lifecycle.

For RealtimeKit specifically:
- App should treat `meeting.localUser.enableScreenShare()` as a “start projection + publish track” operation.
- Expect it to trigger MediaProjection consent UI and/or require the app to already have consent depending on SDK internals.

### Events to wire (MVP)

- Local: `meeting.localUser.screenShareEnabled`
- Remote: `meeting.participants.screenShares`
- Participant update listener has “screen share update” callback (see `android-core/participants/events`).

### Known pitfalls / gotchas

- Android docs ambiguity: RealtimeKit page says “Android API 14 and above” (likely intends Android 14 / API 34). Treat as doc bug; verify in spike.
- Android 14+ enforcement: missing FGS type / permission yields runtime `SecurityException` about `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION`.
- Play Console: targeting Android 14+ requires declaring used FGS types in Play Console (policy/app content).
- OEMs: aggressive background killing; screenshare should run with a foreground service while active.

### Spike checklist (definition of “screenshare works”)

- Android 10–15: start screenshare (consent → projection) → remote sees track.
- Stop screenshare reliably; projection stopped; foreground service removed.
- Rotate screen during share; no permanent freeze.
- Lock/unlock while sharing; graceful resume or clean stop with UI state update.
