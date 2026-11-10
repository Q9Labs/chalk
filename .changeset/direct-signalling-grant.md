---
"@q9labsai/chalk-client": minor
---

Use the direct door a grant advertises (`directSignalingUrl`) for SFU signalling and Sync, fall back to the Tunnel when the door cannot be reached, and record the path each use took as a `transport_path` diagnostic. `SpaceClientPlatform.directPath: "off"` keeps both on the Tunnel.
