---
"@q9labsai/chalk-client": patch
---

A guest keeps hearing another guest after that guest mutes and unmutes their microphone more than once. The SDK no longer stops a remote track or a remote receiver when a publication is withdrawn: it parks the receiver `inactive` and turns it back on when the SFU reuses its mid.
