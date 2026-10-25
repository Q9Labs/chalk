---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react-native": patch
---

Wait for camera and microphone readiness during call startup and temporary recovery instead of reporting a connecting error after a successful toggle. Keep a bounded wait and the original failure feedback, show pending native call controls, and keep the call socket open through temporary iOS permission prompts.
