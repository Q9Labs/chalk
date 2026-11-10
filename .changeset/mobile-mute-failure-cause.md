---
"@q9labsai/chalk-react-native": patch
---

Muting the microphone on Android no longer shows "Couldn’t mute your microphone" with a "Reconnecting…" banner. The native media client did not hand the call controller its mute path (`setLocalSourceIntent` and `closeForcedLocalPublication`), so every mute stopped the audio transceiver and sent an offer without a BUNDLE group, which the phone rejected. The app now passes both, as the web SDK does, so a mute closes over the kept transport. When turning the microphone or camera off still fails, the app also logs the cause: each error in the chain with its SDK code and message, and the top of the innermost stack.
