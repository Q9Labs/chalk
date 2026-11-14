---
"@q9labsai/chalk-client": minor
---

On the Chalk SFU, a joining client lists the publications and pulls the other participants' audio in its first `tracks` request instead of a `publications` request followed by a `tracks` request, which removes one signaling round trip and one cold CORS preflight from the join. `SFUMediaCapabilities` gains `pullPublished`; the client uses the single request only when the SFU advertises it. Cloudflare behavior is unchanged.
