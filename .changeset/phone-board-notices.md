---
"@q9labsai/chalk-react": minor
"@q9labsai/chalk-ui": patch
---

Float faces over a phone board, and place call notices only where they fit. On
a phone, an open board now fills the stage and up to three faces float at its
right edge, with short name tags. Notices sit between the header and the
controls under them, sized to the call, so an embedded call behaves like a full
window. A notice shows only where its whole message fits without covering a
header, board, dock or reaction control. A notice with no room waits in a
notice button in the header, which lists it whole; its timer starts only once
it shows. Long names, links and error tokens wrap inside their notice, and a
long call name shortens to make room for the timer and the notice button.

New optional props: `ToastStackProps.onFold` reports the ids of the notices
that have no room, and `SpaceHeaderProps.notices` places a control before the
people button.
