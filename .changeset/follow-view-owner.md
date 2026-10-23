---
"@q9labsai/chalk-client": patch
"@q9labsai/chalk-react": patch
"@q9labsai/chalk-whiteboard": patch
---

Converge Follow views on one Episode owner, recover from its canonical snapshot,
and preserve real camera moves during recovery and tab switches. Zoom controls
and keyboard moves now consistently leave Follow and lead the person's view.

Keep all 500 active people's views using internal schema-generated limits in the client and React caches. Public bounds, event unions and decoded-frame unions remain unchanged.
