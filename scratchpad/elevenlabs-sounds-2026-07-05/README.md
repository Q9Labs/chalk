# ElevenLabs sound set — 2026-07-05

240 one-shot UI sounds (10 sets × 24 events) generated from
`docs/redesign/sound-design.md`. Ogg Opus, stereo, 48 kHz,
`prompt_influence: 0.7`, `output_format: opus_48000_128`.

`sounds/<set>/<event>.ogg` holds the canonical take for each sound.

`manifest.json` records the full generation record, including each sound's
prompt, its `canonicalTake` index, and every take's ElevenLabs `historyId`.

**The `raw/` directory referenced by `manifest.json` no longer exists.** Its 960
alternate takes (19 MB) were removed once the canonical selections were in
place; they remain in git history, and the manifest still identifies each one by
`historyId` should a different take ever be wanted.
