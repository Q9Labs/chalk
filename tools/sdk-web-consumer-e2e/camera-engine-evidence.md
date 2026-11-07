# Linux WebKit camera-frame exception

Only the advancing-camera-frame assertion is excluded in the Linux Playwright
WebKit agreement project. Microphone playback energy, own controls, local SDK
state, every observer projection and camera/microphone badge remain required.
Chromium and macOS WebKit still require advancing camera frames. Codec selection
is unchanged; no VP8 pin was added.

## Matched platform checks — 29 October 2026

All runs use packed SDKs, two participants, and the healthy-toggle scenario with
both directions checked at every settle point. WebKit uses the iPad Pro 11
profile, not iPad hardware. The macOS runs used WebKit 27.2, revision 2370, on
macOS 27.0.1 (arm64). No physical camera is needed: the published sources are the
fixture's animated canvas and oscillator.

### macOS WebKit: all frame assertions enabled

Product master `d2046ab4dccd63348267d303d8cd80bed0a62023`, with master-based
#598 `36fc45597b46bce3fdd8b610f71e176c18fe89e0` (faithful publication retention).
Outbound and rendered frame counts below are diagnostic snapshots during each
trial; the agreement checker separately requires advancement after every toggle.
Both observed remote videos were playing (`paused=false`, `readyState=4`), with
no media-element error in these snapshots.

| Trial | Result | Alice outbound framesEncoded | Bob outbound framesEncoded | Alice video received by Bob | Bob video received by Alice |
| ----- | ------ | ---------------------------- | -------------------------- | --------------------------- | --------------------------- |
| 1     | PASS   | 22                           | 27                         | 7                           | 25                          |
| 2     | PASS   | 21                           | 27                         | 13                          | 23                          |
| 3     | PASS   | 21                           | 27                         | 11                          | 23                          |
| 4     | PASS   | 19                           | 27                         | 11                          | 23                          |
| 5     | PASS   | 22                           | 27                         | 7                           | 25                          |

Reproduce on macOS after installing the pinned Playwright WebKit binary:

```sh
node tools/sdk-web-consumer-e2e/scripts/run.mjs --browsers=webkit --agreement-only --agreement-fast
```

Real Safari was not run: safaridriver rejected session creation because Safari's
Allow remote automation setting was disabled. This does not claim hardware iPad
or real-Safari proof.

### Linux WebKit: VP8-only diagnostic, not a fixture configuration

Same #598 `349bd6f18ae4a3a7e0b956f4242e9e9a2107b537` fixture for both products:
master `d2046ab4dccd63348267d303d8cd80bed0a62023` and a disposable stack with
#597 `5d622306f144f519d249d0623984b6068cada77c`. Counted successful local SDP
operations form one offer/answer pair per negotiation. The counts exclude the
one initial handshake and stop before scenario teardown.

| Trial | Master result | Master renegotiations | #597 stack result | Stack renegotiations |
| ----- | ------------- | --------------------- | ----------------- | -------------------- |
| 1     | FAIL          | 3                     | FAIL              | 0                    |
| 2     | FAIL          | 0                     | PASS              | 3                    |
| 3     | PASS          | 3                     | PASS              | 3                    |
| 4     | FAIL          | 3                     | PASS              | 3                    |
| 5     | PASS          | 3                     | PASS              | 3                    |

Master passes 2/5; the stack passes 4/5. The zero-renegotiation failures occur
after the first mic-off and before any camera-off. Successful runs have the same
three renegotiations on both products. Extra #597 camera retirement/republication
does not explain these failures.

VP8 failures have advancing local canvas/media-source frames but frozen outbound
`framesEncoded` and remote rendered frames, with no HTMLMediaElement error.
Separate `GST_DEBUG=2` captures of failed VP8 trials do **not** contain the fatal
H264 `not-negotiated` / `Internal data stream error` path below. They contain:

```text
ERROR video-info ... gst_video_info_from_caps: no format given
WARN decodebin3 ... Requested streams from no known collection
```

Those startup/warning lines also occur in passing VP8 trials; they do not prove
the cause of the encoding stall. A standalone one-way canvas loopback did not
reproduce the two-participant stall. The exact VP8 engine cause remains unproved.

### Linux WebKit: original H264 playback failure

The unchanged default-codec fixture also fails on master, not only the stack.
Five targeted trials gave master 4/5 and stack 2/5. Affected videos were fully
inside the viewport, then emitted an error and paused while the inbound RTP
`framesDecoded` counter continued to increase. Browser stderr identified:

```text
ERROR decodebin3 ... Switching from passthrough to parsebin on inputs is not supported !
WARN basesrc ... Internal data stream error.
WARN basesrc ... streaming stopped, reason not-negotiated (-4)
ERROR webkitmediaplayer ... Internal data stream error.
```

The media element reported error code 4, `Internal data stream error.` This is
the Linux GStreamer playback path, not evidence of a stopped published camera.
The later macOS 5/5 run retains camera-frame coverage without this Linux engine
path. Raw diagnostic logs are retained in the worker's handoff artifacts; no
production identifiers or private raw artifacts are committed here.

## Publication fidelity is separate

The fixture keeps advertised publications and their IDs when
`clearPreparedLocalTrack` detaches capture, matching production's reuse behavior.
It honors `stopTrack: false`. Only explicit forced retirement removes a retained
advertisement; a subsequent fresh enable publishes a new ID. The contract test
fails against the former helper that silently removed the advertisement.

A focused OS-ended-camera Chromium probe exposes the stale advertisement on both
master and #597 `5d622306`: the owner is Off, but the class still projects On.
The full matrix remains held pending the builder's final #597 revision; neither
the Linux frame exception nor the fixture contract test claims that cleanup bug
is fixed.
