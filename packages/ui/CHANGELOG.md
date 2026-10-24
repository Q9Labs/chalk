# Changelog

## 5.2.0

### phone-board-notices-next-release

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
tile when there is no explicit cap. A capped strip or floating column counts
shared content and its overflow button against that cap; folded shares stay
readable in the shared-content overflow. One text-only announcer handles
notice speech independently of its stage or header presentation.

New optional props: `ToastStackProps.onFold` reports the ids of the notices
the stage has no room for, `ChalkToastProps.announce` lets a host that already
announced a notice keep its toast quiet, and `SpaceHeaderProps.notices` places
a control before the people button.

## 5.1.0

- Round the call's corners and lift board messages clear of the controls. This is a stylesheet change with no API changes.
- Stack call notices below the reaction tray (`z-index` 45 instead of 90), and leave room for `@q9labsai/chalk-react` to lift them clear while the tray is open.

See the [project changelog](../../CHANGELOG.md) for the coordinated v5.1 release.

## 5.0.0

- BREAKING: Classic is the only UI style. Remove skin controls and hand-drawn rendering helpers.
- Remove preset palettes, textures, and animated icons. Keep light and dark modes and custom tokens.
- Align the shared quick reactions with the call design: 👍 ❤️ 😂 😮 🎉 👏.
- Require `@q9labsai/chalk-assets` v5.

See the [project changelog](../../CHANGELOG.md) for the coordinated v5 release.
