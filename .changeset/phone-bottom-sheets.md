---
"@q9labsai/chalk-react": minor
---

On phones, the microphone and camera pickers, the reactions tray, the call menu and More are bottom sheets that you can drag down by the handle or heading to close. Press and hold the microphone or camera button to open its picker, so phones get a microphone picker; More also lists "Microphone and speaker" and "Camera", shows an unread badge on Chat, and no longer has a call link row (the call menu copies it). Sheet rows are 48 px high, and the bottom padding follows the safe area, so pages that host the call should add `viewport-fit=cover` to their viewport meta.
