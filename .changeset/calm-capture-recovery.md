---
"@q9labsai/chalk-client": patch
---

Reuse microphone and camera senders after short browser capture interruptions,
keeping capture disabled until a fresh user enable. Republish after long
interruptions before trusting an expired provider track, and detach again if
capture is interrupted during reattachment. Include a bounded replacement cause
on the first SFU track request after a media connection is replaced.
