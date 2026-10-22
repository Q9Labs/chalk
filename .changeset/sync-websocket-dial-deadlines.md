---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react-native": patch
---

Bound each Sync and whiteboard WebSocket opening attempt to 10 seconds by default, then retry through the existing reconnect backoff. Clear the deadline when the socket opens or stops and ignore late opens from expired attempts. Retain a redacted Sync dial-timeout diagnostic after recovery.

Allow a longer opening deadline through the transports' existing options, and preserve React Native's existing 30-second startup allowance (including larger configured allowances) for both transports.
