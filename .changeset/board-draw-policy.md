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

The whiteboard client now steps its hello down only when Sync can't decode it (close
1009). A rejected token or a late hello (close 1008) is retried at the same level up to
four times, so a brief token problem no longer hides the drawing policy for the rest of
the connection. On a Sync without the drawing policy, a host's waiting policy change is
refused as `unavailable`, and also reported on the summary, instead of being replayed.
