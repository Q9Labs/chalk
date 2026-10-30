---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react": patch
---

Keep other audio and video flowing when retiring a sender that does not own the bundled transport, and rebuild conservatively when bundle information is unavailable. Retry republished remote tracks promptly with per-publication backoff that survives presence changes, and replace expired receiver sessions even while old browser tracks remain live. Attach replacement audio track objects in React even when their IDs are unchanged.
