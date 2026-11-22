# Screen annotation on an Android phone

Use Android 14 or newer, a USB cable with debugging enabled, and a desktop
browser. The APK has its own application ID, so it does not replace Chalk from
Google Play. It includes its JavaScript bundle; it needs neither Metro nor USB
after installation.

## Install

From a checkout of the screen annotation branch with JDK 17, the Android SDK,
and pnpm available, start an Orb and copy the HTTPS **web** origin it prints:

```sh
orb up chalk feat/screen-annotation
bash apps/mobile/scripts/build-orb-apk.sh "$ORB_WEB_ORIGIN"
```

Set `ORB_WEB_ORIGIN` to that origin before running the build. Run the
`adb install -r` command printed by the script, then open the new Chalk app.
Open the same Orb call in the desktop browser and paste its invite into
**Join with a link** on Android. Use a files-enabled Orb for Add to board and a
recording-enabled Orb with running capture and render workers for playback.

## Check on the phone

- **Entire screen:** In the Android call choose **Share screen → Entire screen**.
  Allow the overlay, then show a dark, moving screen. Draw a kept stroke from
  the web viewer. Check the stroke on Android and in the video at the viewer.
  Pause, resume, and clear. The controls must work and must not appear in the video.
- **Single app:** Stop sharing, start again, and select one app. Move or scroll in
  that app: the web viewer must receive changing video. Draw again; the viewer
  should see the data-layer stroke, but the selected app on Android must not.
- **Android viewer:** Join as a viewer of another Android phone sharing its full
  screen. Draw a kept stroke; it must appear at touch-down. Record the viewer
  at 60 fps or faster, preferably with a high-speed camera and a dark, moving
  source. Step through from release until the video carries the stroke. Record
  the largest count of consecutive frames with doubled ink or no ink. If you
  cannot distinguish the presented frames, do not record a pass. Repeat with
  a highlighter and across a stop/start.
- **Add to board:** On the Android viewer, save the annotated share. The board
  must get one image, with no extra editable stroke on a full-screen share.
  Save a single-app share separately and check that its ink stays editable.
- **Recording:** Record a full-screen share and a single-app share. Keep a
  highlighter stroke visible in each. Play both recordings; the full-screen
  stroke should appear only once, and the single-app stroke should appear
  even though it was absent from the live source video.

Save screenshots and measurement notes under `.verify/android-annotation-phone/`.
When finished, run `orb verify` and `orb down` for the test Orb.
