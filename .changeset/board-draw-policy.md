---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": minor
---

Add a call-wide drawing policy for the board: everyone, only hosts, or picked people.
Hosts set it with `setDrawPolicy` on the whiteboard transport and pick people with the
existing `setDrawPermission`. Sync computes each person's permission and sends it with
the policy over the new `draw_policy_v1` extension, so the summary and
`useWhiteboard().access` now carry `canDraw`, `drawPolicy` and the host's per-person
choices. The React board follows that permission instead of the role capability, and
hosts get a "Who can draw" section with a person picker in the board menu.
