# Android publishes a single app

Use an Android 14 or newer device with Chalk installed and a desktop browser
in the same live call. Keep the browser's call visible. Do not use a fixture
that replaces MediaProjection or signaling.

1. Open Clock on Android and start its stopwatch.
2. Return to the Chalk call. Choose **Share screen**, then **A single app**.
   Tap **Start** and select Clock.
3. Keep Clock in the foreground. On desktop, verify that the received screen
   video shows Clock and that the stopwatch digits advance. Do not return to
   Chalk on Android to make the video appear. Save screenshots of both sides.
4. Stop sharing on Android. Verify that the desktop stops showing Clock.
5. Start another share using **Entire screen**. Open Clock again and verify
   that the desktop video updates, including the Android system bars.

The third step catches the regression: capture consent and the Android sharing
indicator can succeed while the viewer never receives a frame.
