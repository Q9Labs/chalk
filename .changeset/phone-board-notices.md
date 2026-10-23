---
"@q9labsai/chalk-react": minor
"@q9labsai/chalk-ui": patch
---

Float faces over a phone board, and keep call notices off the call's controls.
On a phone, an open board now fills the stage and up to three faces float at
its right edge, with short name tags. Notices sit between the header and the
controls under them. A call shorter than 620px, such as a landscape phone or a
short embedded call, puts every notice in a notice button in the header, which
lists each one whole and announces it once to screen readers; a taller call
shows the newest three and puts older ones in the button. A notice in the
button starts its timer only once it shows. The header stays visible while
the button holds notices. Long names, links and error tokens wrap inside
their notice, and a long call name shortens to make room for the timer and
the notice button. A screen share beside a short board always keeps its own
tile instead of folding into the people overflow.

New optional props: `ToastStackProps.onFold` reports the ids of the notices
the stage has no room for, `ChalkToastProps.announce` lets a host that already
announced a notice keep its toast quiet, and `SpaceHeaderProps.notices` places
a control before the people button.
