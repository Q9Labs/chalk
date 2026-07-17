# Architecture zoom sensitivity session log

- 2026-07-17 20:35 PKT — Started reducing touchpad zoom sensitivity in the Kaadr and Chalk architecture pages.
- 2026-07-17 20:35 PKT — Found that both pages applied a fixed 12% zoom-in or 11% zoom-out change to every wheel event, ignoring the touchpad's delta magnitude.
- 2026-07-17 20:35 PKT — Replaced the fixed wheel-event jump with delta-proportional exponential scaling at a sensitivity of `0.002`; button and keyboard zoom increments remain unchanged.
- 2026-07-17 21:10 PKT — Browser verification confirmed a `deltaY` of `-10` now produces a roughly 2% zoom step and the inverse event restores the prior scale. The repository commit gate passed hygiene, Fallow, Semgrep, and secret scanning, then stopped at the repository-wide OSV scan because 169 existing dependency advisories were reported outside this HTML change.
