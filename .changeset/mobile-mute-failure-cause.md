---
"@q9labsai/chalk-react-native": patch
---

When turning the microphone or camera off fails on a phone, the app now logs the error behind the "Couldn’t mute your microphone" toast: each error in the chain with its SDK code and message, and the top of the innermost stack. Turning on already reported its failure to the person; the cause of either was never logged.
