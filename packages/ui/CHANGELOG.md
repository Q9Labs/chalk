# Changelog

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
