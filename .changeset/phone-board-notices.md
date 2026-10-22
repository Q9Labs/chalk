---
"@q9labsai/chalk-react": minor
"@q9labsai/chalk-ui": patch
---

Float faces over a phone board, and place call notices only where they fit. On
a phone, an open board now fills the stage and up to three faces float at its
right edge, with short name tags. Notices sit between the header and the
controls under them, keyed on the call's own size, so an embedded call behaves
like a full window. A notice shows its whole message, never covers a header,
board, dock or reaction control, and older notices wait while there is no room.
When even the newest notice has no room, such as in a short call with the
drawing tools open, the header shows a notice button that opens every notice.

New optional props: `ToastStackProps.onFold` tells a host when notices have no
room, and `SpaceHeaderProps.notices` places a control before the people button.
