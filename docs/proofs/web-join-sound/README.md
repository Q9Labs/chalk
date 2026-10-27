# Web join-sound proof

[The sanitized log](result.json) records two real SDK clients in a temporary Q9
proof Space on nightly API and Sync. A local page rendered the production
`useSoundCues` hook inside `ChalkProvider` after awaiting `client.join`, as the
call view does. The deployed nightly web bundle was not changed.

Chromium enforced `document-user-activation-required`. Each participant clicked
Join once, with no later click. Both joined with microphone and camera disabled,
so microphone capture could not bypass autoplay. The log records native Web
Audio oscillator starts and context states, not a replacement sound player.

| Event                                                              | Before                   | After                                                             |
| ------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------- |
| First participant joins                                            | No tone                  | No tone                                                           |
| Second participant joins                                           | No audio context or tone | Existing participant gets one two-note chime in a running context |
| Entrant loads the existing roster                                  | No tone                  | No tone                                                           |
| Existing participant's real Sync socket disconnects and reconnects | Not checked              | Neither participant gets another join tone                        |

Both runs ended the Episode and archived the Space. No recording started.

The focused tests cover throttling to one chime every three seconds, returning
participants, self joins, initial rosters, reconnects, the embedding opt-out, and
silent playback failures. Four of the five tests fail against the old sound
implementation. All five pass with the fix.

```sh
pnpm --dir sdks/typescript/react exec vitest run src/internal/useSoundCues.test.tsx src/internal/sound-cues.test.ts
```

Not checked: Firefox, Safari, or a deployed web build with this branch. This
change does not publish an SDK or alter the native sound path.
