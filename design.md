---
name: Chalk
colors:
  surface: "#000000"
  surface-container: "#060606"
  surface-container-high: "#0C0C0C"
  on-surface: "#ECECEE"
  on-surface-variant: "#9A9CA3"
  primary: "#ECECEE"
  on-primary: "#000000"
  secondary: "#55AAC9"
  on-secondary: "#000000"
  outline: "rgba(255,255,255,0.4)"
  outline-variant: "rgba(255,255,255,0.045)"
  error: "#FF6B6B"
call-dark:
  canvas: "#000000"
  surface: "#060606"
  raised: "#0C0C0C"
  hover: "#161616"
  pressed: "#1F1F1F"
  tile: "#060606"
  popover: "#0C0C0C"
  line: "rgba(255,255,255,0.045)"
  line-strong: "rgba(255,255,255,0.08)"
  wash: "rgba(255,255,255,0.05)"
  wash-strong: "rgba(255,255,255,0.08)"
  text: "#ECECEE"
  text-strong: "#FFFFFF"
  text-soft: "#C4C6CC"
  text-muted: "#9A9CA3"
  danger: "#E5484D"
  danger-hover: "#EC5D61"
  danger-text: "#FF6B6B"
  success: "#80B879"
  warning: "#D9B641"
  info: "#55AAC9"
call-light:
  canvas: "#F3F3F5"
  surface: "#FFFFFF"
  raised: "#ECECF0"
  hover: "#E1E1E6"
  pressed: "#D3D3D9"
  tile: "#E2E2E7"
  popover: "#FFFFFF"
  line: "rgba(0,0,0,0.09)"
  line-strong: "rgba(0,0,0,0.15)"
  wash: "rgba(0,0,0,0.04)"
  wash-strong: "rgba(0,0,0,0.07)"
  text: "#18181B"
  text-strong: "#000000"
  text-soft: "#3D3E45"
  text-muted: "#5C5D65"
  danger: "#D93A3F"
  danger-hover: "#E04B50"
  danger-text: "#BF272C"
  success: "#2B8A3E"
  warning: "#8A6400"
  info: "#1B70A0"
call-fixed:
  overlay: "rgba(0,0,0,0.75)"
  overlay-strong: "rgba(0,0,0,0.82)"
  overlay-hover: "rgba(34,34,34,0.95)"
  on-overlay: "#FFFFFF"
  overlay-warning: "#E2BD3A"
  overlay-danger: "#FF6B6B"
  hand: "#DCB740"
  on-hand: "#16140C"
  scrim: "rgba(0,0,0,0.55)"
board-surface:
  chalkboard: "#1C2622"
  chalkboard-ink: "#F1F0EA"
  chalkboard-muted: "#AEB9B4"
  paper-light: "#F5F2EA"
  paper-dark: "#EAE6DB"
  paper-ink: "#1B1C1F"
  paper-muted: "#5D5A52"
  dot-on-dark: "rgba(255,255,255,0.11)"
  dot-on-light: "rgba(0,0,0,0.16)"
  select-on-dark: "#7DB8FF"
  select-on-light: "#1F6FD0"
board-pen:
  red: "#E23240"
  orange: "#C15A10"
  green: "#288A51"
  blue: "#1F7AD6"
  violet: "#935AE2"
board-note:
  ink: "#F6E27A"
  red: "#F2A3A8"
  orange: "#F4BE8C"
  green: "#A8DBB8"
  blue: "#A9CDF2"
  violet: "#CDB8F2"
  text: "#1B1C1F"
board-person:
  p1: "#1D70C5"
  p2: "#8753D0"
  p3: "#D02E3B"
  p4: "#257F4B"
  p5: "#B2530F"
  p6: "#1B7979"
  p7: "#C0307A"
  p8: "#62751D"
  p9: "#3B6FD4"
  p10: "#A14FB5"
  p11: "#B5512C"
  p12: "#297F65"
typography:
  interface: "Figtree"
  mono: "Spline Sans Mono"
rounded:
  tag: 6px
  tile: 12px
  menu: 12px
  card: 16px
  round: 999px
---

# Design System: Chalk

Source-derived using [Google Stitch's DESIGN.md guidance](https://github.com/google-labs-code/stitch-skills/blob/main/plugins/stitch-design/skills/extract-design-md/SKILL.md).
Tokens and composed themes live in [shared UI styles](packages/ui/src/styles/index.css), [web theme](apps/web/src/lib/theme.ts), and SDK theme modules. The frontmatter holds the call's dark and light palettes under `call-dark` and `call-light`; `colors` repeats the dark one in Stitch's roles, because the site, the docs and the dashboard open dark too. This file owns visual direction, not delivery status. All sizes are CSS pixels, measured on a 1440 by 900 laptop unless a phone is named.

## 1. Visual Theme & Atmosphere

Chalk has one look. The call is dark, calm, and sparse, and the marketing site, the docs and the dashboard wear the call's own design: its themes, components, radii, icons, avatars, motion and copy rules. X Calls (call.x.com) is the reference for the call's calm: Chalk takes its restraint, not its pixels.

Six principles govern the call:

1. **Content owns the stage.** Video, shared screens, and boards take all the space the layout can give them. Shared content is never cropped and never sits between black bars.
2. **The chrome fades.** After three seconds without pointer movement, the header and dock fade out and return on the next movement, so nothing competes with the people.
3. **Dark by default, two themes only.** The call opens dark. A Light/Dark switch in the call details popover is the only appearance control for the chrome. There are no named palettes and no textures in the chrome. The board's surface is content, not chrome, so each person picks it from the board menu.
4. **One quiet kit.** Every call surface uses the same few shapes: round and pill buttons, 12px tiles and menus, 16px cards. The call has no glass, no glow, no gradient on chrome, and no colored shadow.
5. **Color carries meaning.** Red means leave or off, green means healthy, yellow means attention, and blue means unread or yours. Nothing else gets color.
6. **Small life, no noise.** Faces react, tiles lift two pixels, buttons press, and tiles glide to new places. Each effect confirms something, and each moves only transform and opacity.

The marketing site, the docs and the dashboard open dark like the call and switch to light with the same saved preference. Their structure comes from spacing and one-pixel lines, the inverted pill marks the decisive action, and color keeps the call's meanings. They have no named palettes and no textures.

## 2. Color Palette & Roles

### The call

Both call themes share one set of roles. Dark is the default. Light is a designed counterpart, not an inversion: white cards sit on a light gray canvas, and raised controls are one step darker than the cards.

| Token         | Dark                      | Light              | Use                                                                     |
| ------------- | ------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `canvas`      | `#000000`                 | `#F3F3F5`          | Call background and status pages                                        |
| `surface`     | `#060606`                 | `#FFFFFF`          | Panel card, ready card, people pill, header buttons                     |
| `tile`        | `#060606`                 | `#E2E2E7`          | Tile background and the letterbox color of shared content               |
| `raised`      | `#0C0C0C`                 | `#ECECF0`          | Round dock buttons, fields, chat bubbles, selected rows                 |
| `popover`     | `#0C0C0C`                 | `#FFFFFF`          | Menus, popovers, toasts, floating chips                                 |
| `hover`       | `#161616`                 | `#E1E1E6`          | Hover surface of a raised control or row                                |
| `pressed`     | `#1F1F1F`                 | `#D3D3D9`          | Pressed surface, switch track when off, meter track                     |
| `line`        | `rgba(255,255,255,0.045)` | `rgba(0,0,0,0.09)` | Card borders and hairlines                                              |
| `line-strong` | `rgba(255,255,255,0.08)`  | `rgba(0,0,0,0.15)` | Menu and popover borders, dividers inside controls                      |
| `wash`        | `rgba(255,255,255,0.05)`  | `rgba(0,0,0,0.04)` | Hover wash over a tile; `wash-strong` (0.08 and 0.07) is the press wash |
| `text`        | `#ECECEE`                 | `#18181B`          | Text, icons, and the fill of inverted buttons                           |
| `text-strong` | `#FFFFFF`                 | `#000000`          | Hover state of an inverted button                                       |
| `text-soft`   | `#C4C6CC`                 | `#3D3E45`          | Secondary text on cards and in menus                                    |
| `text-muted`  | `#9A9CA3`                 | `#5C5D65`          | Meta, placeholders, section labels, inactive icons                      |
| `danger`      | `#E5484D`                 | `#D93A3F`          | Leave button and Stop sharing; `danger-hover` is `#EC5D61` or `#E04B50` |
| `danger-text` | `#FF6B6B`                 | `#BF272C`          | Off-state icons, error text, End call for everyone                      |
| `success`     | `#80B879`                 | `#2B8A3E`          | Level meter, switch on, good signal, copy done                          |
| `warning`     | `#D9B641`                 | `#8A6400`          | Weak signal, blocked-device badge, raised-hand icon in a row            |
| `info`        | `#55AAC9`                 | `#1B70A0`          | Unread dot and your own message reactions                               |

Colors that stay the same in both themes, because they sit on video or stand for a fixed meaning:

| Token                               | Value                                                                                  | Use                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `overlay`                           | `rgba(0,0,0,0.75)` with `#FFFFFF` text                                                 | Name tags, signal chip, tile and share hover buttons                   |
| `overlay-strong`                    | `rgba(0,0,0,0.82)`                                                                     | Share notes, the switcher, and the own-share bar                       |
| `overlay-hover`                     | `rgba(34,34,34,0.95)`                                                                  | Hover state of an overlay button                                       |
| `overlay-warning`, `overlay-danger` | `#E2BD3A`, `#FF6B6B`                                                                   | Raised-hand and weak-signal marks, and the mic-off mark, on an overlay |
| `hand`                              | `#DCB740` with `#16140C` text                                                          | Raised-hand order badge and the active Raise hand row                  |
| `scrim`                             | `rgba(0,0,0,0.55)`; the photo viewer uses `rgba(8,8,10,0.94)`                          | Behind phone sheets, small dialogs, and the photo viewer               |
| Identity colors                     | `#315F72`, `#5C6650`, `#6B5B4F`, `#64576B`, `#49645D`, `#665D42`, `#4D5D73`, `#6D5158` | Avatar background, chosen by a hash of the person's name               |
| File types                          | PDF `#C42B2B`, Word `#2F5FB3`, Excel `#1E7A46`, PowerPoint `#B8481E`, other `#5C5D65`  | Badge behind the white type label on a file card                       |

Color rules for the call:

- Red marks leaving, stopping, and off states. No other control is red.
- A control that is on in a meaningful way inverts: `text` as the fill and `canvas` as the icon color. Muted microphone and camera stay on the raised surface and show a slashed `danger-text` icon.
- Never use color as the only cue. Pair it with an icon, a label, a shape, or a position.
- Muted text reaches 4.5:1 on the canvas and on every surface up to `hover` in both themes. State colors reach 3:1 on the canvas and on every surface up to `hover` in both themes.
- In the light theme, controls that sit on the canvas (dock buttons, people pill, corner buttons) carry a one-pixel `line` ring, and menus, toasts, and cards add `0 12px 32px rgba(0,0,0,0.12)`. In the dark theme they need neither.

### The marketing site, the docs and the dashboard

They use the call's two themes with the same roles, dark first. One `chalk_theme` preference drives the call and the site, so a switch on either changes both. A page opens the call's token scope (`data-chalk`) on its root, and the theme button in the top bar (the Appearance control in the dashboard's account menu) switches it.

Three tokens exist only on these pages, because they hold forms and long reading that the call does not have:

| Token            | Dark                    | Light              | Use                                                                                                       |
| ---------------- | ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `--edge`         | `rgba(255,255,255,0.4)` | `rgba(0,0,0,0.46)` | Field borders and link underlines, so a boundary holds `3:1` on every surface                             |
| `--redbtn`       | `#C93D42`               | `#D93A3F`          | Fill of a destructive button, which keeps white text at `4.5:1`; it is the call's pressed red in the dark |
| `--redbtn-hover` | `#D13438`               | `#C4373C`          | Hover state of a destructive button                                                                       |

Rules for the site, the docs and the dashboard:

- Raised cards (`surface`) carry a one-pixel `line` border in the dark theme. In the light theme they drop the border and take the call's light card shadow, `0 0 0 1px line, 0 12px 32px rgba(0,0,0,0.12)`.
- Code samples sit on `surface` with a `line-strong` border and a `raised` header, in four colors: keyword `#F0997D` or `#A1442A`, string `#9CD39A` or `#2B7A4B`, comment `#9A9CA3` or `#5C5D65` in italic, and type `#7CC7E8` or `#1B6A8E` (dark or light).
- The hero's one highlight is the blue chalk stroke behind "inside your product." No other gradient, glow or wash.
- A product picture is drawn from the call itself, a still drawing in the call's proportions and tokens, so it follows the theme. Recordings keep the dark call's colors in both themes, because they are video.

## 3. Typography Rules

Chalk uses two type families. Figtree sets everything, in the call and on the site, the docs and the dashboard, headlines included; Spline Sans Mono sets numbers and technical text.

| Role      | Family             | Weight         | Use                                                                                                       |
| --------- | ------------------ | -------------- | --------------------------------------------------------------------------------------------------------- |
| Interface | `Figtree`          | `400` to `700` | The whole call; headlines, headings, body text, buttons, inputs, and labels on the site and the dashboard |
| Mono      | `Spline Sans Mono` | `400` to `600` | Marketing performance numbers and technical metadata                                                      |

Call type scale. Text is Figtree with a line height of `1.4`, in sentence case.

| Style          | Size and weight                  | Use                                                         |
| -------------- | -------------------------------- | ----------------------------------------------------------- |
| Status title   | `22px`, `600`                    | Status page sentence                                        |
| Limbo title    | `20px`, `600`                    | Limbo message; the progress line beside a spinner is `17px` |
| Card title     | `15px`, `600`                    | Call name, "Your call is ready", popover and dialog titles  |
| Phone row      | `16px`, `400`                    | Rows in phone sheets                                        |
| Body           | `14px`, `400` to `500`           | Menu rows, messages, toasts, fields                         |
| Button         | `13px`, `600`                    | Pill buttons, chips, segmented controls                     |
| Label and meta | `12px` to `13px`, `500` to `600` | Name tags, section labels, times, help lines                |

The timer, counts, diagnostics, and file sizes use tabular figures so digits do not jitter. Names carry `dir="auto"` so right-to-left names set correctly. The avatar initial is drawn by the Facehash package.

Site type scale. Everything is Figtree at `600` for headings, except the speed numbers in Spline Sans Mono. Sizes step down at a 1280 laptop and on a phone.

| Style          | Desktop                                                  | Laptop | Phone  | Line height             | Typical use                       |
| -------------- | -------------------------------------------------------- | ------ | ------ | ----------------------- | --------------------------------- |
| Hero           | `92px`                                                   | `80px` | `46px` | `1` (`1.04` on a phone) | The landing headline              |
| Section title  | `56px`                                                   | `50px` | `34px` | `1.04`                  | Landing section headlines         |
| Speed number   | `68px`                                                   | `60px` | `52px` | `1`                     | Mono, `500`, the three budgets    |
| Docs title     | `44px`                                                   | `44px` | `38px` | `1.08`                  | Article title                     |
| Docs heading   | `23px` and `18px`                                        | same   | same   | `1.25`                  | Article sections and subsections  |
| Lede           | `19px`                                                   | `19px` | `16px` | `1.55`                  | The line under the hero           |
| Body           | `16px` in the docs, `14px` to `17px` on the landing page |        |        | `1.45` to `1.65`        | Copy                              |
| Label and meta | `12px` to `13.5px`                                       |        |        | `1.4`                   | Sidebar groups, times, fine print |

Hero and section titles use tight tracking between `-0.035em` and `-0.045em`. Interface text uses normal tracking. Uppercase is limited to short external conventions, never routine navigation.

## 4. Component Stylings

### The call kit

Every call control follows the same rules, so a new control needs no new decisions.

- Buttons are round or pill. Dock buttons are `44px` (`52px` on a phone), header buttons `40px`, icon buttons in cards `36px` (`44px` on a phone), menu rows `40px` (`48px` on a phone), and sheet rows `52px`.
- On hover, a raised control steps to `hover`, a row steps to `raised`, and a tile takes `wash`. On press, a control steps to `pressed` and scales to `0.94` (round buttons), `0.97` (pills and header buttons), or `0.92` (small icon buttons).
- Focus shows a two-pixel ring in `text` with a two-pixel offset. Inside tiles, rows, and menus the ring sits inside the control. Text fields change their border to `text` instead. A control never stacks a ring, a border change, and a shadow.
- A tooltip appears after `400ms` of pointer hover, never on touch. It is an inverted pill at `12px`, `600`, and repeats the control's accessible name.
- Pill buttons are `36px` high (`32px` small) at `13px`, `600`. The secondary pill uses `hover` as its fill, the primary pill is inverted, and a disabled pill drops to `40%` opacity.
- A switch is a `36px` by `22px` track with a `16px` knob. The track is `pressed` when off and `success` when on.
- Icons are a rounded outline family with a `1.75px` stroke. They are `20px` by default, `18px` in menus and cards, and `14px` to `16px` in tags and chips.
- One menu component serves every menu. It has a `popover` surface, a `12px` radius, a one-pixel `line-strong` border, `6px` padding, and a shadow of `0 12px 32px rgba(0,0,0,0.5)`. Rows are `40px` high with a `9px` radius, an `18px` muted leading icon, and an `18px` column for the check on the selected row. Section labels are `12px`, `600`, `text-muted`, in sentence case. Arrow keys move, Enter picks, and Esc closes and returns focus to the trigger. A menu opens above dock buttons, below header, row, and tile buttons, and stays `8px` inside the call.

### Header

The header is transparent over the canvas, `60px` high (`52px` on a phone), with `24px` of padding on the left and `16px` on the right. It carries no logo and no Invite button.

- On the left, the call name and the timer form one button with a `14px` chevron after the timer. It has a `40px` pill shape, a `raised` hover background, a pressed state, the tooltip "Call details", and opens the call details popover. While recording, a `13px` "Rec" label with an `8px` red dot follows it.
- When your own connection is weak, a `32px` warning pill with signal bars and "Weak connection" appears beside the name and opens the same popover.
- On the right, the people pill is `40px` high on `surface`. It shows up to three overlapping `24px` faces (overlap `7px`, each ringed in the pill color) and the count in tabular figures, and it opens the People tab.
- Next to it, one `40px` round button switches between Spotlight and Grid. Its tooltip names the layout it switches to.
- On a phone, the header shows only the call name with its chevron and the timer. Tapping the name opens the call details as a bottom sheet.

### Dock

The dock sits `20px` above the bottom edge (`42px` on a phone), centered, with `8px` between controls and an extra `8px` after the camera and before Leave. It lives in a reserved row, so it never covers a tile. From left to right it holds:

1. Microphone and camera. Each is a split pill: a `48px` main button and a `36px` caret with a `16px` muted chevron. They hover and press separately. When off, the icon is slashed in `danger-text` on the `raised` surface. When the browser or system blocks the device, a `16px` yellow "!" badge sits on the pill and a tap explains how to allow it.
2. Share, as a split pill with a caret. While you share, the pill inverts, the main button stops the share, and the caret menu offers "Share something else" and "Stop sharing" in `danger-text`.
3. Reactions, board, record (hosts only), and fullscreen, each a round button. A raised hand puts a `9px` yellow dot on the reactions button. Board and record invert while active.
4. Leave. It is a round `danger` button with a white hang-up icon, and it is the only red control in the dock. A guest who clicks it leaves at once and lands on the status page. A host gets a small menu above the button with "Leave call" and "End call for everyone" in `danger-text`.

Two round buttons sit in the bottom corners, `20px` from the edges. The link button at the bottom left toggles the "Your call is ready" card. The chat button at the bottom right opens Chat and shows a `9px` blue dot for unread messages. A new message also shows a chat peek for four seconds above the chat button: a bubble with the sender's avatar, name, and first line, which opens Chat when clicked.

**Reactions menu.** The first row is a "Raise hand" toggle, which turns `hand` yellow when on. Six emoji follow as `40px` round buttons: thumbs up, heart, laughter, surprise, celebration, applause. A reaction floats up from the sender's tile and fades over two seconds.

**Share source menu.** The caret opens three `52px` rows with a plain icon, a label, and one line of help: "Entire screen" (Everything on one display), "Window" (One app, like Slides or Figma), and "Browser tab" (One tab, and its sound if you like). A check marks the last choice. A separator and a "Share tab audio" switch follow, with the help line "Works when you share a browser tab". The share button without the caret reuses the last choice, and Window is the first. The choice goes to the browser as the `displaySurface` hint. Browsers that cannot share hide the button.

**Phone dock.** One row of five `52px` round buttons with safe-area padding: microphone, camera, reactions, More, and leave. Carets are hidden. More opens a bottom sheet with a drag handle and `52px` rows: Copy link, Share screen (where the browser can share), Board, Chat, People, and Layout as a Spotlight/Grid segmented control.

### Device menus

Menus for the microphone, speaker, and camera open from the carets, are `320px` wide, and use the call's menu component.

- The microphone menu starts with a "Microphone" section: the device list with a check on the selected device and a live input level meter under its name. The meter is a `4px` bar with a `success` fill that scales on its X axis. A "Noise suppression" switch row follows. After a separator comes a "Speaker" section with its own device list and a "Test speaker" row that plays a short chime and reads "Playing…" while it sounds.
- The camera menu starts with a `150px` live preview with an `8px` radius and the label "Only you see this preview". A "Camera" section lists the devices, and after a separator a "Mirror my video" switch row follows.
- Long device names are truncated with an ellipsis. When a device is unplugged, a toast says "Switched to" and names the fallback.

### Person tiles

A tile has a `12px` radius (`14px` on a phone), no shadow, and the `tile` background. Video fills it with cover, so a tile may crop a camera but never shows a bar. A tile is one button: a click pins that person in Spotlight, and the tile takes `wash` on hover and lifts `2px`.

- **Camera off.** A round Facehash avatar sits at the center. Its diameter is `42%` of the tile's shorter side, between `32px` and `150px`. The avatar uses one of the eight identity colors, chosen from the person's name. Tile avatars use the bold 3D style (`intensity3d="dramatic"`). Small avatars in the people pill, rows, chat, and toasts use the subtle style (`intensity3d="subtle"`). Avatars use a flat fill, with no gradient, glow, or ring.
- **Avatar life.** The eyes follow the pointer, and the face blinks. On hover the face turns to the front. While the person speaks, the face reacts to the live level: the mouth opens and the face bobs. A reaction or a raised hand makes the face briefly excited. All avatar motion stops with reduced motion, on touch devices, for avatars that are off-screen, and while the chrome is idle.
- **Speaking with the camera on.** A live ring appears inside the tile edge: three pixels of white with a one-pixel dark outer line. Its opacity follows the voice level, from `0.3` to `1`, and it fades out in `200ms` when the voice stops. A thin lime tile edge is not used.
- **Name tag.** The tag sits `8px` from the bottom-left corner. It is `24px` high with a `6px` radius, the `overlay` fill, and white `12px`, `500` text that truncates with an ellipsis. Compact `14px` icons follow the name: pin, microphone off in `overlay-danger`, and a raised hand in `overlay-warning`. When two or more hands are up, the hand shows its order number. Your own tile reads "Name (You)", or "You" when it floats.
- **Signal.** When a person's connection is weak, a `24px` overlay chip at the top left shows four signal bars, with the lit bars in `overlay-warning`.
- **Hover controls.** At the top right, a `32px` round `overlay` button opens a menu with Pin (or Unpin), and Mute for hosts. On touch, a tap on the tile opens the same actions in a bottom sheet.
- **Overflow tile.** When more people exist than fit, the last tile reads "+N" on the `raised` surface, is named "Show all N people", and opens the People tab.
- **Floating tile.** A tile that floats over the stage, such as the second person on a phone call of two, gets a one-pixel `line-strong` ring and a shadow of `0 6px 18px rgba(0,0,0,0.5)`.

### Shared screens

A shared screen is a tile like any other: the same radius, the same `tile` surface, and the same letterbox color. The content is contained, never cropped.

- **Someone else's share.** A chip at the bottom left is styled exactly like a name tag. It shows a share icon and "Nora's screen", plus a speaker icon when the share has tab audio. Hover controls sit at the bottom right as `32px` round `overlay` buttons: Fit or Fill, Zoom, Pop out (picture-in-picture), and Fullscreen this share. On touch, a tap on the tile shows them. The mouse wheel also zooms, up to four times.
- **States.** While connecting, the tile holds its place with a spinner and "Connecting to Nora's screen…", so the stage does not jump. When the share pauses, the last frame stays at `35%` opacity under a pause badge and "Nora paused sharing". When it stops, a toast says so while the stage reflows. When two people share, a small switcher at the top left picks whose screen is big, and the other screen sits in a tile. When the connection is slow, the content blurs by `2.5px` and a top-left note with signal bars says "Nora's connection is slow". After a pop out, the tile reads "Nora is in a picture-in-picture window" with a "Bring it back" button. A share the browser or system blocks shows an error toast with the fix: "Allow screen recording for your browser in System Settings".
- **Your own share.** The big tile shows a live preview of what you share, so you can see what others see. An overlay bar floats `10px` inside the top edge, with a `12px` radius and the `overlay-strong` fill. It reads "You're sharing your screen", "You're sharing a window: Google Slides", "You're sharing a tab: Q4 plan", or "You're sharing this tab". It holds a "Change" button, which opens the share source menu, and a red "Stop sharing" button. When you share the entire screen or this tab, a second line says "Seeing a mirror effect? That's normal when you share your whole screen." The dock's share pill shows its active state, and people stay visible around the preview.

### The panel card

People and Chat share one card. It is inset `12px` from the right edge, spans from `60px` below the top to `84px` above the bottom, and is `340px` wide. It uses the `surface` fill, a one-pixel `line` border, and a `16px` radius. It opens in `200ms` with a fade and a `16px` slide, and the stage re-fits beside it. Esc closes it. On a phone it is a bottom sheet `78%` high with a `24px` top radius, a drag handle, and a scrim.

The tab row is `46px` high. "People" shows the count, "Chat" shows a `7px` blue dot for unread messages, the active tab has a two-pixel underline in `text`, and a `36px` close button sits at the right.

**People tab.**

- A `40px` pill search field appears only above eight people.
- Hosts see two controls at the top: "Who can join" and "Mute everyone". "Who can join" is a `36px` pill that shows the current value and opens a menu with "Anyone with the link" (People join right away) and "Ask to join" (You let each person in). "Mute everyone" opens a small confirm popover, "Mute everyone?" with the line "N people will be muted. They can unmute themselves.", then shows a toast. Guests never see either control.
- Sections run in this order: "Waiting" for hosts, with Deny and Let in on each row; "Raised hands" when two or more hands are up, numbered in order, with Lower for hosts; then "In the call".
- A row is `52px` high with a `32px` avatar, the name, a muted "(You)" or "Host", a mic-off icon, a hand icon, and a `36px` options button. The menu holds Pin, Edit name on your own row (an inline field with Save), Mute for hosts, and "Remove from call" in `danger-text` for hosts.

**Chat tab.**

- A message is a `raised` bubble with an `18px` radius and `8px` by `12px` padding. Your messages sit on the right. Messages in a run from one person share a single header with the name and the time at `12px`.
- The composer is a `44px` pill field with a paperclip on the left, the placeholder "Message everyone", and a `36px` round inverted send button. Send stays disabled until there is text or a ready file, and Enter sends. A message typed while reconnecting shows "Sending…".
- An empty chat shows "No messages yet" and the line "Messages are seen by everyone in the call."

**Attachments.** Chat accepts PNG, JPEG, GIF, WebP, PDF, plain text, Word, Excel, PowerPoint, and OpenDocument files, up to five per message and `25 MB` each.

- A file arrives by the paperclip, by a drop onto the card, or by pasting an image. A drag over the card shows a drop zone with a dashed `1.5px` border, the title "Drop files to send", and the line "Up to 5 files, 25 MB each".
- Staged files sit as chips above the field, `44px` high with a `12px` radius. Each chip has a `32px` thumbnail or file-type badge, the name, the size, a remove button, and a progress ring over the thumbnail while it uploads. Send waits until every upload finishes. A file that is too large or of the wrong type gets a `danger` border and its error text on its own chip.
- In a message, images appear as thumbnails with a `14px` radius: one large image `240px` wide, two side by side, three as two above one wide, and four or more in a two-by-two grid whose last tile shows "+N" when more remain. A click opens the photo viewer.
- The photo viewer covers the call on the dark viewer scrim. A top bar shows the file name, the position, a download button, and a close button. Previous and next arrows step through the images, Esc closes it, focus stays inside it, and focus returns to the thumbnail on close.
- Other files appear as a `240px` card, at least `56px` high, with a `14px` radius, a `36px` type badge, the name, the size, and a download button.
- The card states are: sending (the message drops to `55%` opacity with a `3px` progress bar), failed (an error line with a "Retry" link), preview loading (the thumbnail pulses between full and `45%` opacity), and expired (a dashed border and "This file has expired" with no download).

**Message reactions.** Hovering or focusing a message shows a bar above it, and a long press shows it on a phone. The bar holds six quick emoji at `30px` and a "+" that opens a grid of more emoji. Reactions sit under the message as `26px` pills with the emoji and a tabular count. Your own reactions use `info` mixed `20%` into the surface, with a border of `info` at `65%`. A click on a pill toggles yours, and hovering or long-pressing a pill lists who reacted.

### Call details popover

The call name button opens one popover that holds everything about the call itself. It is `368px` wide, opens under the button `12px` from the left edge, and scrolls when it is taller than the call minus `150px`. It uses the menu surface and opens in `180ms` with a fade and a `6px` drop. On a phone it is a bottom sheet. Esc closes it and returns focus to the name button. A title row shows the call name and a close button, and hairlines separate these sections:

1. **Share.** The link `chalkmeet.com/q9-team` sits in a `44px` pill with a copy button. Below it, a `112px` QR code with an `8px` radius, black modules on a white quiet zone in both themes, sits beside the line "Scan with a phone camera to join this call."
2. **Connection.** A row shows signal bars and "Connection: good" or "Connection: weak", with a line such as "Audio and video are clear" or "Video quality is lowered to keep audio clear". It expands to a list of round trip, upload, download, packet loss, region, video resolution, frame rate and codec, audio codec, and the selected microphone, speaker, and camera. A "Copy diagnostics" button copies the list.
3. **Appearance.** A Dark/Light segmented control switches the call theme at once.
4. **Sounds.** A switch turns call sounds on or off.
5. **Keyboard shortcuts.** This row opens a small dialog that lists them: Mute or unmute `⌘D`, Turn camera on or off `⌘E`, Raise or lower hand `⌃⌘H`, Open or close chat `⌃⌘C`, Open or close people `⌃⌘P`, Switch layout `⌃⌘L`, Talk while muted (hold Space), Show shortcuts `?`, and Close a menu or panel `Esc`. Other platforms show their own modifier keys.
6. **Report a problem.** This row opens a short form with a "What went wrong?" text area and an "Include diagnostics" checkbox that is on by default. Send stays disabled until there is text. While it sends, the button reads "Sending…", and the dialog ends on "Sent" with the line "Thanks. We'll look into it." The status pages carry a quiet "Report a problem" link that opens the same form.

The keyboard and report dialogs are `400px` wide, centered over the `scrim`, with a `16px` radius, a `line-strong` border, and a shadow of `0 16px 40px rgba(0,0,0,0.5)`. On a phone they are bottom sheets.

**The copy control.** One control copies the link in the ready card, the popover, and the phone sheet. It is a `36px` round icon button. After a press, the copy icon morphs into a `success` check, with a crossfade, a scale from `0.4`, and a small turn over `200ms`. After two seconds it morphs back. A polite live region announces "Link copied".

### Toasts and notices

A toast is one line: a `20px` icon or `28px` avatar, a short sentence, at most one or two action pills, and a close button on errors. It uses the `popover` fill, a one-pixel `line` border, a `12px` radius, a minimum height of `48px`, and a shadow of `0 8px 24px rgba(0,0,0,0.4)`. Toasts stack up to three, `8px` apart, centered `92px` above the bottom edge (`110px` on a phone). They enter with an `8px` rise and a fade over `200ms` and leave with a fade over `160ms`. Info toasts leave after five seconds. Error and knock toasts stay until closed. A long error may wrap to two lines when it must explain a fix.

- Errors use `role="alert"`: "Your camera is being used by another app" with "Try again".
- For hosts, a knock reads "Nora Patel wants to join" with Deny and Let in, and the person also appears under "Waiting" in the People tab.
- Info toasts cover requests and events: "Akash asks you to unmute" with Unmute, "Nora Patel joined", "Nora muted you. Unmute when you're ready.", "Nora left. You're now the host.", "Nora stopped sharing", and the start and stop of recording.
- A hint above the microphone says "You're muted. Press ⌘D to unmute." when you speak while muted.
- A banner under the header reads "Your browser paused the sound. Click to hear the call." It is an inverted `44px` pill.
- When a call is recorded, the header shows the Rec label, and the Name needed, Joining, and Knocking cards carry the line "This call is recorded. By joining, you agree to be recorded."

### The ready card

The "Your call is ready" card sits above the link button, `20px` from the left edge. It is `320px` wide and uses the `surface` fill, a one-pixel `line` border, and a `16px` radius. It shows the title, a close button, the line "Share this link with people you want in the call", and a `44px` link pill. The pill holds the link, a QR button that expands a `112px` QR code with its scan line, and the copy control. The card opens by itself when you are alone in the call and closes when anyone joins. The link button toggles it at any time. On a phone it is a bottom sheet.

### Limbo

Waiting states look like the call itself, blurred. A stand-in call (the header with the call name, one empty tile, the dock outline, and nothing real) sits under a static `18px` blur and a dim, with a centered message card on top. The card uses `surface`, a `16px` radius, and `22px` by `28px` padding.

| State         | The card says                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Joining       | A spinner and "Joining Q9 team…"                                                                                        |
| Name needed   | A `320px` card with the label "Your name", a `44px` field, and "Join call", disabled until there is text; Enter submits |
| Knocking      | "Asking to join Q9 team", "The host will let you in.", and Cancel                                                       |
| Knock refused | "The host didn't let you in" and "Ask again"                                                                            |
| Reconnecting  | The real call under a `10px` blur and desaturation, with a spinner and "Reconnecting…"                                  |

While reconnecting with a queued chat message, the card adds "1 message will send when you're back". Queued actions send on their own, with no dialog.

There is no pre-join screen. People join at once, muted and with the camera off. The web app asks for a name only when it does not know one, and the Name needed card is that ask. When the blur ends, the filter is removed at once and a veil in the canvas color fades from `60%` to nothing over `300ms`, so the blur radius itself never animates. With reduced motion, the veil starts at full opacity and fades.

### The status page

One full-canvas page covers every case where the call stops for you. It shows a centered sentence at `22px`, an optional muted line, and a row of `56px` round `raised` buttons with a `13px` label under each, `28px` apart. Below them, a quiet underlined "Report a problem" link opens the report form. The page has no call id, no statistics, and no countdown.

| Case                    | Sentence                      | Line                                                                       | Buttons         |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------- | --------------- |
| You left                | You left Q9 team              |                                                                            | Rejoin, Home    |
| The host ended the call | The call ended                |                                                                            | Home            |
| Connection failed       | Couldn't connect to Q9 team   | Check your internet connection, then try again.                            | Try again, Home |
| You were removed        | You were removed from Q9 team | The host removed you from this call.                                       | Home            |
| The call is full        | This call is full             | Q9 team has reached 100 people. Ask the host to make room, then try again. | Try again, Home |
| Open in another tab     | You joined from another tab   | Q9 team is open in another tab or window. Use it here instead?             | Use here, Home  |

Rejoin, Try again, and Use here return to the Joining state.

### The board

The board is shared content. Excalidraw is the drawing engine, run in its light theme with all of its own interface hidden. Its dark theme inverts the canvas colors, so Chalk keeps the engine light and owns the palette, the surface, and every control. The board never shows the engine's menus, toolbars, welcome screen, or help. It follows the placement rules of a shared screen: it is contained, never cropped, and has the tile radius (`12px`, `14px` on a phone). In Grid it is a real double-width tile with a "Board" name tag. It shows the board's live content, refreshed about once a second, and a click on it switches to Spotlight.

While the engine loads, the board holds its place with its surface color, a spinner, and "Opening board". The engine then fades in over `200ms`. Opening scales the board in from `97%` over `260ms`, and closing fades it out over `160ms`.

**Surfaces.** Each person picks one of three surfaces for themselves. The choice lives in the board menu and is saved on the device. It is never shared, so two people in one call can see different surfaces. The surface belongs to the board's content, not to the call chrome: the Light/Dark switch does not change it, except that Paper is a little dimmer in the dark call and the Dot grid takes the call's own `surface`. Chalkboard is the default.

| Surface    | Fill                                                    | Ink       | Detail                                                                                                    |
| ---------- | ------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| Chalkboard | `#1C2622`                                               | `#F1F0EA` | A faint grain (`5%` white noise) and a soft light at the top. It is the one textured surface in the call. |
| Paper      | `#F5F2EA` in the light call, `#EAE6DB` in the dark call | `#1B1C1F` | Flat                                                                                                      |
| Dot grid   | `surface`                                               | `text`    | `1.3px` dots in `rgba(255,255,255,0.11)` or `rgba(0,0,0,0.16)`, `24px` apart at `100%` zoom               |

The dots move with pan and zoom, and their spacing doubles whenever it would fall under `14px`, so the grid never crowds. Moving the dot pattern changes a background offset, which is paint only. It is the one update on the board that is not a transform or an opacity. Selection boxes, the text field border, and the focus ring on the canvas use `#7DB8FF` on the dark surfaces and `#1F6FD0` on the light ones.

**Pens.** The palette has six colors: Ink, Red, Orange, Green, Blue, and Violet. Ink is the surface's own ink, so it turns light or dark with the surface. The other five are the same on every surface and reach `3:1` on all of them: Red `#E23240`, Orange `#C15A10`, Green `#288A51`, Blue `#1F7AD6`, and Violet `#935AE2`. A stroke is Thin, Medium, or Thick, which is `2.5`, `4.5`, or `8` board units, so strokes scale with zoom. The Highlighter draws four times as wide as the pen at `40%` opacity with flat ends, and with Ink chosen it draws orange. The Eraser removes whole shapes. Someone's drawing keeps the pen color they chose, whatever surface you see it on.

**The tool island.** A pill on the `surface` fill with a `26px` radius, `6px` padding, `2px` between buttons, a one-pixel `line-strong` ring, and a shadow of `0 8px 24px rgba(0,0,0,0.35)` (`0.12` in the light theme). Buttons are `40px` and round (`44px` on touch and on a phone) and follow the call kit: `hover` on hover, scale `0.92` on press, the active tool inverted, and a disabled button at `35%` opacity. Hairline separators group the tools. From the start, the island holds:

1. The grip, then Select (V) and Hand (H).
2. Pen (P), Highlighter (U), and Shapes (R).
3. Text (T), Sticky note (N), Math (M), and Image (I).
4. Eraser (E) and Laser pointer (K).
5. Undo and Redo, which are disabled when there is nothing to undo or redo.
6. The color button, a `22px` swatch with a ring.

Every button has an accessible name and a tooltip with its key. Shapes opens a menu with Rectangle (R), Ellipse (O), Diamond (D), Arrow (A), and Line (L), and the button shows the shape you used last. The color button opens a small popover with the six `40px` swatches (a `24px` dot, with a `text` ring on the chosen one) over the three stroke widths. A change applies to the current selection as well as to the next stroke. A sticky note takes the pastel of the chosen color. Math opens a `360px` popover with a LaTeX field, a live preview, example chips, and "Cancel" and "Place on board". Image picks a file, and a file can also be dropped or pasted. The Laser pointer leaves a trail that fades in one second.

**Island position.** The island sits at the bottom, at the top, or at the left, and each person chooses for themselves. The default is the bottom. At the bottom and the top it is centered, `12px` from the edge. At the left it is a column, centered on the height, `12px` from the edge, and it scrolls when the board is short. Fit and the first view keep content clear of it. Two things set the position: the "Tool island" tiles in the board menu, and the grip.

- The grip is `22px` by `40px` (`40px` by `22px` at the left) with six dots and a grab cursor. After `4px` of movement, the island follows the pointer with a transform, lifts above the board with a stronger shadow, and three dashed drop zones appear: `70px` bands along the left, bottom, and top edges, with a `2px` dashed border and a `8%` wash in the selection color. The zones show at `45%` opacity, and the one nearest the pointer shows in full.
- On release, the island snaps to the nearest zone and glides from where it was dropped to its place with a transform and an opacity fade over `300ms`, on the call's `cubic-bezier(0.16, 1, 0.3, 1)` curve. A canceled drag returns to the old place.
- With the grip focused, Left, Down, and Up arrows move the island, and a polite live region says "Tool island moved to left".
- The island is compact on a phone and whenever the board is narrower than `1060px`. Compact has no grip and no position choice. It is one `44px` button at the bottom left with the pen icon and a dot in the chosen color. A tap opens the full row, which scrolls sideways and starts with a close button, and a long press (`500ms`) opens the color popover.
- A person who cannot draw has no island.

**The board menu.** A `40px` round button at the top right (`44px` on a phone) opens a `304px` menu on the call's menu component. In order, it holds Download as PNG and Copy as image; then "Board appearance", with the "Surface" tiles (Chalkboard, Paper, Dot grid) and, outside a phone and for people who can draw, the "Tool island" tiles (Left, Bottom, Top). A tile is a `38px` preview over its name, and the chosen one has a two-pixel `text` border. For hosts, "Who can draw" follows, with the radio rows Everyone and Only hosts, then Bring everyone here and Clear board in `danger-text`. Close board comes last. A guest sees the download items, the appearance section, and Close board.

**People around the board.** The board adds no floating faces and no people pill. People sit in the strip or the column that The call stage picks for shared content. A face never shows that someone is drawing, because the cursor and the strokes already do. While the board is open, a click on a person's tile follows that person instead of pinning, and the followed tile takes a two-pixel `text` ring and the word "following" in its name tag. When more people exist than fit, the last tile reads "+N" and opens a short list of everyone, with a Follow button on each row that reads "Following" when on.

**Cursors.** Each remote person has one cursor, and one color: a rounded arrow, with the avatar below and to the right of its tip, and the name tucked behind the avatar. The arrow is `22px` by `26px` with rounded joins, a white outline, and a soft shadow. The avatar is the call's Facehash, `26px`, with a two-pixel white ring. The name is a `28px` pill with `13px`, `600` white text on the person's color, a `1.5px` white ring, and a small shadow. The name slides out from behind the avatar (`10px` over `300ms`, with a fade) while the person moves, and when your pointer is within `26px` of the cursor. It slides back in `700ms` after they stop. A person is moving above `25px` a second on your screen.

Each person has one of twelve colors, assigned when they join and kept for the whole call. White text reaches at least `4.5:1` on every one. The same color draws the arrow, the name pill, the person's laser trail, and the outline around the shapes they select (`2.5px`, drawn above the shapes). Cursors are hidden from assistive technology, because the people list already names everyone. Positions are in board coordinates, so a cursor stays on its content as you pan and zoom. When you are offline, remote cursors fade out, because their updates have stopped.

Updates arrive about 15 times a second, and not at an even pace. The shown cursor is a spring that chases the newest position on every frame, critically damped so that it never overshoots, and exact for any frame time. Its rate is `16` a second at rest and `24` while the person draws, so it covers 90% of a gap in about a quarter of a second at rest and in about a sixth while the person draws. A cursor never waits for an update, and it never jumps between two.

**Follow and Bring everyone here.** Follow makes your view track another person's view. Click their tile or the Follow button in the "+N" list. Your view eases to theirs and keeps tracking, and a Following chip shows at the top center with a Stop button. Stopping, panning, zooming, or using Fit ends it. A second click on the tile also ends it. Stopping by hand shows the toast "Stopped following Nora". Hosts can choose Bring everyone here in the board menu. It sends everyone to the host's current view, and each person follows the host from there. Anyone can break away by moving their own view.

**Sticky notes.** The first release has plain sticky notes, with no votes, groups, or timers. A click with the Sticky note tool places a `170px` by `150px` note (board units), opens its text field at once, and the note takes the pastel of the chosen color. Text is `18px` in `#1B1C1F`, on a `4px` radius with a soft drop shadow. A note keeps its place when you pan and zoom, like any other shape.

| Color  | Ink       | Red       | Orange    | Green     | Blue      | Violet    |
| ------ | --------- | --------- | --------- | --------- | --------- | --------- |
| Pastel | `#F6E27A` | `#F2A3A8` | `#F4BE8C` | `#A8DBB8` | `#A9CDF2` | `#CDB8F2` |

**Who can draw.** Hosts choose Everyone or Only hosts. When a person cannot draw, they have no island and the "Who can draw" and "Tool island" items are not offered to them. They see a "View only" chip at the top left and keep pan, zoom, follow, and export. The empty board reads "Nothing here yet. When someone draws, it shows up here."

**Zoom and pan.** A pill at the bottom right (`40px` high, `52px` on a phone) holds Zoom out, the percentage, Zoom in, and Fit. The percentage resets to `100%`. Zoom runs from `10%` to `400%`. The wheel pans, and the wheel with Ctrl or Cmd, or a pinch, zooms at the pointer. Hand, a middle-button drag, or Space with a drag pans, and two fingers pan and pinch on touch. Fit and the buttons ease over a short move. An empty board shows its hint in the middle: "An empty board. Draw, type or drop in an image." with the keys P, T, and ⌘V.

**Toasts and chips.** An event is a toast, and an ongoing state is a chip. Toasts use the call's toast component without change: the same look, the same place, the same timing, and the same polite live region. Chips use the `surface` fill, a one-pixel `line-strong` ring, and the island's shadow.

- Toasts: "Nora opened the board", "Nora brought everyone to this view", "Everyone is following your view" (for the host who did it), "Stopped following Nora", "Only hosts can draw now" or "Everyone can draw now" (for the host who changed it), "Nora limited drawing to hosts" with "You can still look around." added for guests, "Nora let everyone draw.", "You're offline. Drawing keeps working.", "Back online. Your drawing synced.", "Board cleared" with an Undo pill, "Saved chalk-board.png", and "Copied the board as an image". Undo puts the board back while nothing else has changed. Errors use `role="alert"` with a close button and stay until closed: "The browser blocked copying. Use Download as PNG instead.", "Could not save the image. Try again.", "That file is not an image.", and "That image could not be opened."
- Toasts keep the call's place, `92px` above the bottom edge (`110px` on a phone). The one exception is the board: when the bottom island or the phone zoom pill would sit under a toast, the toast steps up to sit `8px` above it.
- Chips: "Following Nora" with a Stop button, and "Offline. Your drawing will sync." Both are `36px` high pills at the top center, `12px` inside the board and `8px` apart. They start `76px` down when the island is at the top. "View only" is a `30px` pill at the top left with a lock icon and `12px`, `600` text in `text-soft`. A chip shows while its state lasts, and a toast tells you when it begins and ends.

**Phone.** The board keeps one hierarchy on a phone. It has a `14px` radius. The island is the compact pen button, and the position choice is not offered. The menu button is `44px`, the zoom pill is `52px` high with `44px` buttons, menu rows are at least `44px` high, and the swatches and widths are `44px`. People sit in the strip below, with a "+N" tile for the rest. Toasts sit `110px` up and step above the zoom pill. Pinch zooms, two fingers pan, and a long press on the pen button opens the color popover.

**Reduced motion.** With `prefers-reduced-motion`, the board opens and closes at once, the island and the people tiles jump to their new places, the engine appears without a fade, and Fit, the zoom buttons, Follow and Bring everyone here jump to the new view instead of easing. The name tucks away with a fade and no slide, toasts and popovers fade in place, and the spinner stops. Cursors still follow their spring, because their movement is the content.

**Keyboard and announcements.** The canvas takes focus, and Space with a drag pans once it has focus. Tools use the keys in the island, Ctrl or Cmd with Z undoes (add Shift to redo), plus and minus zoom, and Esc closes the top layer. A polite live region announces that someone opened the board, that everyone was brought to a view, who can draw, going offline and back online, a cleared board, and a moved island.

### The site and the dashboard

These pages are built from the call kit above, not from a kit of their own: pill buttons (`36px`, `44px` large, `32px` small; `40px`, `48px` and `36px` on a phone), the inverted primary pill, the ghost pill for a quiet action, `36px` round icon buttons (`44px` on a phone), the call's tooltip, menu, dialog card on the scrim, toast and copy control, and Facehash avatars with the subtle style (the bold style inside drawn call tiles). The shell lives in `apps/web/src/components/site`.

- **Fields** are the call's `44px` pill on `raised`, with a one-pixel `--edge` border. Focus turns the border to `text` with a one-pixel `text` ring; an error turns it to `danger-text` and adds an error line with an alert icon under the field.
- **Top bars** are sticky on the canvas. The site bar is `72px` (`64px` on a phone): the lockup, Product, Docs and GitHub as `36px` ghost pills, then the theme button, a ghost "Sign in" and the inverted "Start a call". On a phone the links and Sign in move into a menu sheet. The docs bar is `64px` with a bottom hairline: the lockup, a divider, "Docs", a `300px` search pill with `⌘K`, then GitHub, the theme button and Sign in. The dashboard bar carries the lockup, its tabs and the account menu, whose Appearance control replaces the theme button.
- **The theme button** shows a sun in the dark theme and a moon in the light one, and its name says what it switches to.
- **Docs.** A `264px` sidebar with group labels at `12.5px`, `600` and `36px` rows on a `9px` radius; the current page sits on `hover` at `600`. The article is at most `720px` wide, and a `220px` "On this page" column marks the section being read with a two-pixel `text` rule. Callouts are `surface` cards with an `info` icon (`warning` for cautions). Previous and next are `surface` cards. Below `1080px` the outline folds into a disclosure under the title; on a phone the sidebar opens from a "Menu" bar as a sheet from the left.
- **Search** is a `620px` dialog card `72px` from the top (full screen on a phone): a `58px` field row, results as `9px` rows with a file icon and the matched words marked in yellow, and a footer with the arrow, Enter and Esc keys. ⌘K, Ctrl+K and `/` open it.
- **The lockup** is the B2 chalk stick beside the wordmark in Figtree `700`, drawn in `text`, `24px` high (`22px` on a phone, `26px` in the footer). The call carries no logo.

## 5. Layout Principles

### Spacing

Use a four-pixel base grid. The call favors the smaller steps; marketing compositions may use the larger steps.

| Token      | Value  | Typical use                             |
| ---------- | ------ | --------------------------------------- |
| `space-1`  | `4px`  | Icon adjustment, tight group            |
| `space-2`  | `8px`  | Related controls, the gap between tiles |
| `space-3`  | `12px` | Control clusters, card inset            |
| `space-4`  | `16px` | Default component gap, stage edge       |
| `space-5`  | `20px` | Dock and corner-button inset            |
| `space-6`  | `24px` | Section inside a card                   |
| `space-8`  | `32px` | Desktop panel and card padding          |
| `space-10` | `40px` | Page-level breathing space              |
| `space-14` | `56px` | Desktop container edge                  |
| `space-22` | `88px` | Minimum marketing section space         |

Spacing describes relationships. Use less space inside a component, more space between component groups, and the most space between page sections.

### Marketing

Marketing pages use a centered container up to `1320px`, with `56px` side padding (`40px` on a laptop, `20px` on a phone). The top bar is `72px` high. Sections are separated by space alone, `120px` above and below (`100px` on a laptop, `64px` on a phone), never by rules or boxes. On a phone the page moves to one column and actions take the full width.

The hero is the headline, a lede, and both front doors with equal weight: "Hold a call" with Start a call and a call-link field, and "Build with Chalk" with Read the docs and the install command. Under them sits the call itself in a raised `surface` frame with an `8px` inset and a `20px` radius. Later sections pair a text column (`5fr`) with a product fragment (`7fr`), or set three columns. Technology proof uses logos alone.

### The call stage

The stage is the rectangle between the header and the dock: `16px` from the left and right edges, `60px` from the top, and `84px` from the bottom. That is `1408px` by `756px` on a 1440 by 900 laptop. Tiles sit `8px` apart. An open panel card makes the stage `352px` narrower. The idle fade never changes the stage.

Only two layouts exist: Spotlight and Grid. Both place tiles with the same justified-rows planner.

**Justified rows.** The planner picks a row count and spreads the tiles so that row counts differ by at most one. It stretches each row to the full width and gives every row the same height, so the group fills its area with no empty space. Video crops with cover. Tile aspect stays between about `0.6` and `2`. The planner aims for `0.8` to `2` (4:5 to 2:1) and goes taller, down to `0.6`, or wider, up to `2.4`, only when that avoids an empty gap. A row that would pass `2.4` is centered instead of stretched. Tiles stop shrinking at `150px` by `96px` on a laptop and `88px` by `72px` on a phone. When more people exist than fit, the last tile reads "+N" and opens People. There is no paging.

**Grid.** Justified rows fill the whole stage, with a preferred tile aspect of `1.6`. Shared content is a real tile twice as wide as a person tile, and it shows the live screen or board. A click on it switches to Spotlight.

**Spotlight without shared content.** Alone, you see one tile with an aspect between 4:3 and 16:9, at most `56%` of the stage width, centered. With other people, the active speaker (or the pinned person) takes the main area, cropped with cover, so no bars appear. The speaker changes on its own unless someone is pinned. The others fill a strip below or a column on the right, whichever leaves the main tile closer to 16:9. The strip is `17%` of the stage height, between `104px` and `150px`. The column is `15%` of the stage width, between `180px` and `260px`.

**Spotlight with shared content.** The layout tries two placements and keeps the one that gives the content more area: a strip below it, or a column beside it. A tie, within half a percent, goes to the strip. The content is contained at its own aspect, so it is never cropped. People fill all the area the content leaves with justified rows, so no black bars remain. A wide screen usually gets the strip, a 4:3 or taller screen usually gets the column, and a portrait 9:16 screen stands at full height with people in several columns beside it. The strip and column minimums are the same as above. Pinning a person puts that person in the main area, and the content waits as a tile among the others until the person is unpinned.

A share can go full screen. It then covers the whole call, hides the header and dock, loses its radius, and returns on Esc or the same button.

### Phone

The phone keeps the same hierarchy rather than shrinking the laptop UI. All sizes below are for a 390 by 844 screen.

- The stage is `8px` from the sides, `52px` from the top, and `106px` from the bottom. Tiles have a `14px` radius.
- Alone, you fill the stage. With two people, one person fills the stage and the other floats as a `96px` by `128px` tile at the top right, `12px` inside the corner. With more people, the strip sits below at `30%` of the stage height, and the content-aware placement works in portrait with a column minimum of `120px`. Grid uses the same planner with the phone tile minimums.
- The header, dock, and More sheet are described above. The chrome does not fade on a phone.
- People, Chat, call details, the ready card, tile options, and More open as bottom sheets with a `24px` top radius, a `36px` by `5px` drag handle, and a scrim. A sheet traps focus, and Esc or a tap on the scrim closes it.
- Nothing is hover-only. Tile actions open from a tap, share controls appear on a tap, and message reactions appear on a long press.
- Safe-area insets apply to the dock, the composer, and every sheet.

## 6. Motion and Sound

Motion confirms state changes and spatial relationships. It never performs decoration by itself.

| Motion                    | Duration         | Curve                                     |
| ------------------------- | ---------------- | ----------------------------------------- |
| Hover and press           | `150ms`          | ease-out                                  |
| Chrome idle fade          | `250ms`          | ease-out                                  |
| Menu and popover          | `180ms`          | `cubic-bezier(0.16, 1, 0.3, 1)`           |
| Toast in, toast out       | `200ms`, `160ms` | `cubic-bezier(0.16, 1, 0.3, 1)`, ease-out |
| Panel card and ready card | `200ms`          | `cubic-bezier(0.16, 1, 0.3, 1)`           |
| Phone sheet               | `240ms`          | `cubic-bezier(0.16, 1, 0.3, 1)`           |
| Stage move                | `220ms`          | `cubic-bezier(0.2, 0.8, 0.2, 1)`          |
| Copy icon morph           | `200ms`          | `cubic-bezier(0.16, 1, 0.3, 1)`           |
| Limbo veil                | `300ms`          | ease-out                                  |

- Animate transform and opacity only. Never animate width, height, top, left, or a box shadow. The one filter in the call is the static limbo blur.
- Every change on the stage moves: a layout switch, someone joining or leaving, a share starting or stopping, a panel opening or closing, and the strip moving between below and beside. Each tile is keyed by its person or share and is placed in its final box at once. It then plays a transform from its old box to the new one (translate and scale) over `220ms`. The video element is never re-created or re-parented during the move. A new tile fades in from `97%` scale over `220ms`, and a leaving tile fades out over `160ms`.
- Hover and state changes never shift layout or flicker. Tiles lift `2px` by `translate`, thumbnails scale to `1.03` on pointer devices, and buttons press.
- The chrome fades after three seconds without pointer, keyboard, or focus activity. It stays visible while a menu, card, popover, or toast is open, while keyboard focus is inside it, and outside a live call. A faded chrome ignores the pointer until it returns. The chrome never fades on a phone.
- With `prefers-reduced-motion`, every change is instant or a plain fade. Tiles jump to their new boxes, avatars stop moving, tiles do not lift, reactions fade in place instead of floating, and the limbo veil starts opaque.
- Avoid continuous floating, shimmer on loaded content, elastic overshoot, and repeated status pulsing. The only looping motions are the spinner, the avatar blink, and the loading-preview pulse.

**Sounds.** Call sounds are synthesized in the browser with the Web Audio API, so the call ships no audio files. Each sound is quiet and short, and the Sounds switch in the call details popover turns them all off. The audio context unlocks on the first click or key press, and a browser that blocks audio simply stays silent.

Each event has its own short sound: two rising notes when someone joins, two falling notes when someone leaves, two low thuds when someone knocks, one light tone for a message, two high bell notes for a raised hand, a short falling or rising tick when you mute or unmute, two short notes and one longer note when recording starts, and two soft low notes for an error. Test speaker plays three rising notes and ignores the Sounds switch.

Sound is never the only signal. Every event also has a visible and an announced equivalent.

## 7. Performance

The call must stay smooth on low-end laptops and phones. These rules shape every component, and [the performance budgets](docs/performance-budget.md) hold the measured limits and the scenarios that enforce them. The redesign meets the budgets, and a budget does not loosen to fit a design.

- The call uses no `backdrop-filter`. Floating surfaces use the near-opaque fills in section 2.
- The limbo blur is one static `filter` on one layer, the call layer. It never animates, and it is removed when the call returns.
- The live ring is a fixed ring layer whose opacity changes. No box shadow animates.
- Pointer work is throttled with `requestAnimationFrame`: one sample per frame, only for avatars that are visible, only on fine-pointer devices, and paused while the chrome is idle or motion is reduced.
- Level-driven effects (the meters, the live ring, the speaking face) update at most once per animation frame and change only a custom property, a transform, or an opacity.
- A stage move measures boxes once before and once after the change, then animates on the compositor, so a 24-person Grid keeps its frame rate.

## 8. Accessibility and Product Language

Chalk targets WCAG 2.2 AA in the call, in both call themes, and on the site.

- Body text and essential icons need at least `4.5:1` contrast. Large text and non-text boundaries need at least `3:1`. The dark and light palettes in section 2 meet this for every pair they use.
- Every icon-only control has an accessible name, and a tooltip where the meaning is not universal. A tile's name lists its state, for example "Pin Nora Patel, microphone off, hand raised, number 2", and the visible tag is not read a second time.
- Keyboard users can operate every control: dock, split pills and carets, menus, tabs, rows, tiles, the composer, and the viewer. Focus order follows the visible layout. A menu, card, popover, sheet, dialog, or viewer moves focus inside, and returns it to the trigger on close. Sheets, dialogs, and the viewer trap focus. Arrow keys move through menus and tabs, and Esc closes the top layer.
- Touch targets are at least `44px` square, and the phone dock uses `52px`.
- A polite live region announces joins, leaves, raised hands, new messages, copies, share changes, and the start of recording. Errors and knocks use an assertive alert.
- Never communicate microphone, camera, connection, or recording state through color alone. Off states use a slashed icon, hands use an icon and an order number, and a weak connection uses bars and words.
- Long and right-to-left names truncate with an ellipsis and set with `dir="auto"`.

**Product language.** Copy is calm, direct, and role-neutral. The interface says "call": Join call, Leave call, End call for everyone, and The call ended. "Space" and "Episode" stay in code, API contracts, SDK types, and documentation, and never appear in the call. The call uses the terms People, Chat, Share, Board, Reactions, and Raise hand. Text is sentence case with no em dashes. Buttons name a verb and an object where that fits, and a label states the result when state changes, such as "Mute microphone" and "Turn off camera". An error says what happened, whether the call can continue, and what to do next. The call shows no provider names, implementation status, or SDK language.

## 9. Implementation Notes

First-party CSS tokens live in `apps/web/src/styles/tokens.css`. Product components consume these semantic values instead of adding nearby hex values. Shared React components expose state and composition without forcing a separate visual language. New components reuse the existing color, type, space, radius, elevation, and motion scales. A design that needs a new token adds a semantic token here and in the shared implementation before a component uses it.

Layers stack in this order, from the bottom: tiles (`10`, floating tiles `12`), chrome (`30`), the phone scrim (`38`), cards (`40`, phone sheets `41`, chat peek `45`), limbo (`70`), the status page (`75`), menus (`80`), the call details popover (`85`), toasts (`90`), the photo viewer (`93`), tooltips (`95`), and small dialogs (`96`).

Refine one existing flow at a time. Cover phone, dark and light call themes, empty, loading, denied, error, keyboard-focus, and reduced-motion states. Concepts do not authorize new product scope; [theory.md](theory.md) owns that boundary.
