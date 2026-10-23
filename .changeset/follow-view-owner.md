---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": patch
"@q9labsai/chalk-whiteboard": patch
---

Converge Follow views on one Episode owner, recover from its canonical snapshot,
and preserve real camera moves during recovery and tab switches. Zoom controls
and keyboard moves now consistently leave Follow and lead the person's view.

Expose the protocol-backed `ChalkWhiteboardViewBounds.maxPeople` bound so the client and React caches keep all 500 active people. This additive public bound makes the client change minor; event and decoded-frame unions remain unchanged.
