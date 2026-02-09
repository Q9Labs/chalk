# Background / Interruptions / Audio Routing Research

This is the other “risk spike” after screenshare. Goal: calls stay usable across:
backgrounding, focus loss, device route changes, and OS interruptions.

## iOS

References:
- AVAudioSession: https://developer.apple.com/documentation/avfaudio/avaudiosession
- Handling interruptions (concept): https://developer.apple.com/documentation/avfaudio/avaudiosession/interruption_handling
- Route change notifications: https://developer.apple.com/documentation/avfaudio/avaudiosession/1616501-routechangenotification
- RealtimeKit iOS media devices (device switching): https://docs.realtime.cloudflare.com/ios-core/local-user/manage-media-devices

### Baseline configuration (voice/video call)

Expected app-level audio session:
- Category: `.playAndRecord`
- Mode: `.voiceChat` or `.videoChat` (pick one; validate with RTK + Bluetooth in spike)
- Options:
  - `.defaultToSpeaker` (meeting UX expects speaker by default)
  - `.allowBluetooth` / `.allowBluetoothA2DP` (headsets)

Important: RealtimeKit may also configure `AVAudioSession` internally. Treat the spike as “ensure our config doesn’t fight the SDK”:
- Log current category/mode/options before + after joining
- If the SDK overwrites, decide: do we defer to RTK entirely or re-apply after join

### Speaker toggle + route changes

From upstream sample app patterns:
- Listen to `AVAudioSession.routeChangeNotification`
- On route changes like `.categoryChange` / `.oldDeviceUnavailable`, re-assert speaker route via `overrideOutputAudioPort(.speaker)` if that matches our UX.

Avoid brittle assumptions:
- Wired headset inserted → don’t force speaker.
- Bluetooth connected → don’t force speaker if user selected BT.

Recommendation: keep an “intended route” state:
- `speaker`, `earpiece`, `bluetooth`, `system/default`
- Re-apply only when system changes route away from intended.

### Interruptions (phone calls, Siri, alarms)

Listen to `AVAudioSession.interruptionNotification`:
- `began`: pause local capture UI state; expect RTK to stop sending.
- `ended`: re-activate audio session and re-enable local audio/video if needed.

Acceptance: after interruption ends, user can unmute and audio works without app restart.

### Background behavior (realistic expectations)

iOS limitations:
- Full video capture in background is generally not allowed; audio can continue with `UIBackgroundModes = audio`.

Do **not** casually add `voip` background mode:
- App Store review risk unless we implement correct VoIP semantics (PushKit/CallKit) and use it legitimately.

MVP guidance:
- Add `UIBackgroundModes: [audio]` only if we truly need “keep audio while app is backgrounded”.
- When app backgrounds:
  - keep meeting connected if possible (audio-only)
  - if OS suspends networking, ensure reconnect-on-foreground is solid

### RTK device selection

RealtimeKit exposes audio device selection APIs:
- list via `meeting.localUser.getAudioDevices()`
- set via `meeting.localUser.setAudioDevice(device)`

Spike goal: switching routes via RTK APIs produces expected AVAudioSession route behavior across:
- speaker ↔ earpiece
- speaker ↔ Bluetooth
- Bluetooth connect/disconnect mid-call

## Android

References:
- Android audio focus: https://developer.android.com/media/optimize/audio-focus
- Android 14 foreground service types (calls / projection): https://developer.android.com/about/versions/14/changes/fgs-types-required
- RealtimeKit Android local user (audio devices): https://docs.realtime.cloudflare.com/android-core/local-user/introduction

### Baseline configuration (voice/video call)

Expectations for a meeting app:
- Use `AudioManager.MODE_IN_COMMUNICATION` during an active meeting.
- Request audio focus with `AudioAttributes.USAGE_VOICE_COMMUNICATION`.

Android 15 note (practical):
- Audio focus has tighter background constraints; for reliable calls we should run a foreground service while in-call.

### Foreground service (call)

Recommendation:
- While in meeting, run a foreground service (at least for microphone/camera), and include `mediaProjection` when screenshare is active.
- Ensure notification channel + notification UX exists (low importance).

This is not “UI work”; it’s reliability plumbing.

### Route selection (speaker / earpiece / bluetooth)

Implement (or validate RTK provides) audio device switching:
- API 31+: `AudioManager.setCommunicationDevice(device)`
- Legacy: `startBluetoothSco` / `stopBluetoothSco`, `setSpeakerphoneOn(true/false)` (device-specific quirks)

RTK side:
- `val devices = meeting.localUser.getAudioDevices()`
- `meeting.localUser.setAudioDevice(devices[0])`

Spike goal: confirm RTK device selection maps correctly to Android routing primitives across devices.

### Interruptions / focus loss

Handle `AudioManager.OnAudioFocusChangeListener`:
- `AUDIOFOCUS_LOSS_TRANSIENT`: pause sending audio; show “interrupted” UI.
- `AUDIOFOCUS_GAIN`: resume + re-enable mic if user intended mic on.
- `AUDIOFOCUS_LOSS`: end call or keep connected muted; decide policy.

Also handle:
- Bluetooth connect/disconnect events (route changes).
- App lifecycle: `onPause/onStop` (do not crash; if meeting drops, reconnect on `onResume`).

### Acceptance checklist

- Speaker toggle works; persists across route changes.
- Bluetooth connect/disconnect mid-call doesn’t wedge audio.
- Phone call interruption: meeting recovers without app restart.
- Background for 30–60s then foreground: reconnect behavior is predictable (no “stuck muted”).

