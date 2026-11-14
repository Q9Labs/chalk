---
"@q9labsai/chalk-client": patch
---

A guest who joins a call that already has video now gets the first screen of video with the audio, in the same first pull. Before, the SDK held every video back for 250 ms to let the UI report which tiles are on screen, so the camera came in a second pull after the guest published, which cost two more round trips on the join. The first pull now sends up to four unreported videos at once; a bigger room still waits for the UI's tile reports for the rest, and a video published after the join still waits as before. Audio never waits for video.
