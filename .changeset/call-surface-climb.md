---
"@q9labsai/chalk-react": minor
---

The call invite now lives in the call menu. A host who is alone at call start sees the menu open, titled "Your call is ready", with the QR code expanded, and it closes when someone joins; the rest of the menu is unchanged. `CallReady` is no longer exported, and `ControlBar` no longer takes `shareUrl`, `callLinkOpen`, `onCallLinkToggle` or `onCopyError`, so a standalone `ControlBar` has no Copy call link button; pass `callLinkOpen` and `onCallLinkToggle` to `SpaceHeader` or `SpaceView` instead. The dock has no link button, and the phone call menu has no Show call link row.

Record sits with the dock's centre controls, keeps its neutral fill, and only its glyph turns red while recording. The desktop header keeps its Rec pill, and on a phone the elapsed time turns red while recording. A standalone `ControlBar` shows its media notice or command failure as a dismissible error toast, and `CommandErrorAlert` is no longer exported from `test-support`. Each half of a split dock button shows its own focus ring, and the phone dock fits at 200% zoom.

The dock and header stay visible while the pointer rests on them, and any click on the stage wakes them. The camera menu and the phone device sheets load on intent, so they open at full height. The call menu waits behind the joining card instead of opening over it.

While the link is lost, the header and the stage keep their last picture under one blur and veil, the reconnecting card sits at the centre of the call, and the dock stays sharp and usable. The "Back in the call" confirmation joins the bottom notices. Connection lost is the same card turned into a way back, with Rejoin, Leave call and Report a problem, and no error code; the code goes into the problem report instead. The end screen no longer shows the raw reference code either. `CallLimbo` takes a `secondaryAction` for a quieter second way forward beside the main one. The limbo card shows a blurred stand-in call behind it, and its "This call is recorded" line opens its row instead of popping in.

The people panel uses plain mic and camera icons and a host crown, shows a "Who can join" pill and a compact Mute everyone for hosts, and hides Mute everyone when you're alone. Someone who is reconnecting never leads the stage unless pinned or alone. A side column of shared content keeps people in view instead of folding them into +N, and on a phone the second face floats at the top right of the big tile, clear of the notices at the bottom. A cancelled screen-share picker no longer adds a share tile. Your own big share drops its repeated tag, and on narrow windows its bar moves to the bottom edge. A long tile name ends in an ellipsis, and the tile signal chip uses the name tag's on-media colours. On a phone or touch screen, a tile's More menu opens as a sheet instead of a hover button, and tapping a tile no longer throws a hooks-order error.

The reactions tray closes on a click anywhere else. A chat message's reaction bar opens at the far edge, away from the sender name and time, a failed attachment says "Try again", and the hidden attachment input is out of the tab order. The same board message again replaces its notice instead of stacking a copy.

The call theme uses the shared danger reds, so white text on Leave, Remove and Clear board holds 4.5:1 in both themes.
