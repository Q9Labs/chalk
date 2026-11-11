---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": minor
---

The call now tells a person when their own connection is weak and shows guests the same. A header chip names the level and the cause and opens the connection details, a "very poor" level offers "Turn off video", and tiles show signal bars for a guest on a weak link. The client media state carries `link` (`tier` and `reason`), computed from the 10 second call-stats windows, and `ParticipantPresence` has a new `connectionQuality` (`good`, `weak` or `poor`) that Sync shares between participants when the client asks for it with `connection_quality=1`. When the link drops, the call stays on screen with its last picture dimmed and one calm card with a timer, a "Back in the call" confirmation, and, when recovery runs out, a card with Rejoin, Leave and Report a problem instead of a separate page. This replaces the reconnecting overlay, the offline card and the "Connection is slow" pill.
