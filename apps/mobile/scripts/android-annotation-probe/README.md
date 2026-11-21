# Android annotation capture probe

This builds two debug-only APKs, independent of Chalk's app and dependencies.
The capture app owns a MediaProjection service and an application overlay; the
second app provides an asymmetric target from a different package. The output
PNGs come from the projection's virtual display surface, not a screenshot.

1. With JDK 17 and Android SDK API 35/build-tools 35.0.0, run
   `./build.sh /tmp/chalk-probe` and install both APKs.
2. In Chalk Capture Probe, grant Display over other apps and start the probe.
3. For Entire screen, open Chalk Capture Target within 15 seconds. For A single
   app, choose Chalk Capture Target in the system picker.
4. The service samples its output at baseline, with an ordinary overlay, with
   a `FLAG_SECURE` overlay, and restored. Watch `adb logcat -s ChalkProjectionProbe`.
   Extract each frame with `adb exec-out run-as ai.chalk.probe cat files/ordinary.png`
   (substitute `baseline`, `secure` or `restored` for the other phases).
5. After `phase=permission-check`, revoke Display over other apps in Android
   Settings. Verify that the layer disappears and check for service stop or
   the app process being killed. Stop the probe between modes; it otherwise
   keeps the test window visible for the permission check.

## API 35 emulator result

| Projection | Baseline center | Ordinary overlay | Secure overlay | Restored |
| --- | --- | --- | --- | --- |
| Entire screen | `#50d2e6` | `#d335f9` (ink captured) | `#000000` (black box) | `#50d2e6` |
| Single app | `#50d2e6` | `#50d2e6` (clean) | `#50d2e6` (clean) | `#50d2e6` |

These are results for one API 35 emulator, not a hardware or remote WebRTC
verification. Full-display overlays fail the media invariant. App-only capture
avoids the overlay but cannot provide a portable display-space origin for an
arbitrary selected task. Neither result justifies an external Chalk overlay.
