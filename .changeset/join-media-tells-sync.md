---
"@q9labsai/chalk-client": patch
---

Joining with the microphone or camera on now tells Sync each source is on, so the Chalk SFU forwards it. Before, a call joined with media on carried no audio or video on the Chalk SFU until the user turned a source off and on again. If the connection drops or the call is left before Sync answers, the source stays on and the SDK tells Sync again once the call is back. Only Sync's refusal turns the source off. Cloudflare calls now send the same message, and behave as before.
