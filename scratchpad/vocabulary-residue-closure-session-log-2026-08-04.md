# Vocabulary residue closure — session log (2026-08-04)

- 2026-08-04: Audited the assigned transcription dispatcher, recorder capacity
  validator, and UI animation identifier against `GLOSSARY.md` and the Wave 5
  Episode capacity contract.
- 2026-08-04: Renamed transcription assignment and artifact fields from the
  stale Session/meeting vocabulary to `episodeId`, `episodeStartMs`, and
  `episodeEndMs`. The control API boundary now accepts only canonical
  `episode_id`, `episode_start_ms`, and `episode_end_ms` wire fields; unrelated
  signed-workload snake_case mappings remain unchanged.
- 2026-08-04: Updated normalization, dispatch, finalization, validation, and
  focused fixtures/tests to use the canonical Episode names with no legacy
  aliases or fallbacks.
- 2026-08-04: Renamed recorder validation inputs and capacity intermediates to
  `maxEpisodes`, `episodes`, `episodesPerNode`, and `episodeNodes`, matching the
  Wave 5 formula (`max(ceil(episodes / 4), ceil(participants / 40),
ceil(inputMbps / 16)) + readySpare`).
- 2026-08-04: Renamed the UI exit animation keyframe from
  `chalk-meeting-exit` to `chalk-episode-exit`.
- 2026-08-04: Review follow-up keeps both canonical camelCase Episode inputs
  and canonical snake_case control-wire inputs in the transcription
  canonicalizers, with focused assertions for each boundary shape.
- 2026-08-04: Renamed package UI lobby tokens/comments to Entrance vocabulary
  and corrected the remaining whiteboard fanout `_room` binding to `_space`.
- 2026-08-04: Added `lobby` to the language ratchet's tracked banned terms,
  extended the identifier-boundary test, and recomputed deterministic baseline
  counts: apps/web 5, apps/mobile 36, React 2, React Native 16, tools 3,
  docs 7, root 19; all other surfaces are zero.
