---
"@q9labsai/chalk-client": patch
---

On the Chalk SFU, a guest who joined a call after someone else could lose the whole media connection, for about ten seconds, the first time they muted or published after that someone muted. The SDK stopped the receiver of the withdrawn remote track, and when that receiver carried the connection's BUNDLE transport, the guest's next offer dropped the transport and the SFU session with it. Audio and video, sent and received, stopped until the SDK replaced the connection. The SDK now parks that one receiver inactive and keeps the transport.
