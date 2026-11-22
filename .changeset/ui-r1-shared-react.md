---
"@q9labsai/chalk-react": minor
---

Shared call UI polish. New `ChalkCheckbox` export from `@q9labsai/chalk-react/components`. `ChalkCopyButton` forwards its ref and props, so a tooltip or menu can use it as its trigger. It and `InviteLinkButton` keep their label and morph the copy icon into a check and back. Toasts and the header's notice button merge repeats of one message (closing it closes them all), and the stack shows at most three. Blocked-device and capture-failure notices say what is blocked and where to fix it, in one short sentence. The media request dialog answers sit side by side at the full card width on a phone. The details sheet takes focus itself when it opens.
