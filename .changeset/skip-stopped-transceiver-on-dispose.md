---
"@q9labsai/chalk-client": patch
---

Leave on React Native no longer logs "Could not get transceiver" as an uncaught promise rejection (a red toast in debug builds). Closing the media connection now skips a transceiver that is already stopped, because stopping it a second time rejects natively.
