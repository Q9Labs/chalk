# Browser Document Picture-in-Picture Reference

Validated: 2026-03-09

Purpose: quick, accurate reference for anyone touching Chalk's Document PiP work.

## What Document PiP is

- Document Picture-in-Picture opens an always-on-top window that can contain arbitrary HTML, not just a single `<video>`.
- It is different from classic video PiP (`HTMLVideoElement.requestPictureInPicture()`), which only floats one video element with browser-owned controls.
- For conferencing UX, Document PiP is the right API because we can render custom controls, multiple streams, labels, and fallback UI.

## Core API surface

- Feature detection:

```ts
const supported =
  typeof window !== "undefined" &&
  "documentPictureInPicture" in window &&
  typeof window.documentPictureInPicture?.requestWindow === "function";
```

- Open window:

```ts
const pipWindow = await window.documentPictureInPicture.requestWindow({
  width: 420,
  height: 460,
});
```

- Current PiP window, if already open:

```ts
const pipWindow = window.documentPictureInPicture.window;
```

- `requestWindow()` returns a same-origin `Window` object for the PiP document.
- `DocumentPictureInPicture` also exposes an `enter` event.

## Hard requirements

- Secure context only. Treat this as HTTPS-only in production.
- Must be called with transient user activation. In practice: button click / key press handler.
- Must be called from the top-level window.
- Do not call it from inside the PiP window itself.

## Important behavior constraints

- One Document PiP window per browser tab/top-level traversable.
- Opening another Document PiP window for the same tab closes the previous one.
- The PiP window never outlives the opener tab/window.
- The PiP window cannot be navigated like a normal popup.
- The site cannot position the PiP window.
- The browser may clamp requested `width` / `height`.
- If you pass only one of `width` or `height`, `requestWindow()` throws `RangeError`.
- Document PiP windows cannot enter fullscreen.

## Lifecycle notes that matter in Chalk

- Cleanup on `pagehide` from the PiP window.
- Re-render content into the PiP document when call state changes.
- Copy styles/theme tokens into the PiP document; it starts as a blank document.
- Keep logic in the opener app; render a lightweight PiP view into the PiP window.
- Prefer runtime detection over browser-name checks.
- Expect Chromium-first support. Do not promise availability on all browsers.

## Good implementation pattern

- Keep a ref to the returned PiP `Window`.
- Create a React root/portal into `pipWindow.document`.
- Sync theme attributes and copied stylesheets into the PiP document.
- Treat external close as state change and sync back into React immediately.
- Gate open/toggle behind explicit user action.

## Chalk-specific guidance

- Prefer `usePictureInPicture()` in `sdk-react` instead of ad-hoc browser calls.
- For turnkey flow, keep shared PiP state above prejoin/meeting so the same PiP window can survive phase changes.
- For meeting UX, choose one primary source for the stage in PiP; update live as screen share / active source changes.
- Always keep a "Back to tab" path available unless we intentionally pass `disallowReturnToOpener: true`.

## Errors / failure modes to expect

- `NotSupportedError`: API disabled or unsupported.
- `NotAllowedError`: no user activation, not top-level, or called from the PiP window.
- `RangeError`: only one dimension passed, or negative dimension values.

## Styling / CSS facts

- The PiP document is a real document; normal DOM/CSS works.
- The spec/MDN also define `display-mode: picture-in-picture`, so PiP-specific CSS is possible.

```css
@media all and (display-mode: picture-in-picture) {
  body {
    margin: 0;
  }
}
```

## What not to assume

- Do not assume support from `document.pictureInPictureEnabled`; that is for classic video PiP.
- Do not assume a browser will honor exact requested window size.
- Do not assume iframe support; the API is top-level only.
- Do not assume classic video PiP permissions-policy docs fully cover Document PiP behavior.

## Sources

- MDN: Document Picture-in-Picture API
  - https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API
- MDN: `DocumentPictureInPicture`
  - https://developer.mozilla.org/en-US/docs/Web/API/DocumentPictureInPicture
- MDN: `DocumentPictureInPicture.requestWindow()`
  - https://developer.mozilla.org/en-US/docs/Web/API/DocumentPictureInPicture/requestWindow
- MDN: Using the Document Picture-in-Picture API
  - https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API/Using
- Chrome Developers: Picture-in-Picture for any element, not just `<video>`
  - https://developer.chrome.com/docs/web-platform/document-picture-in-picture
- WICG spec: Document Picture-in-Picture Specification
  - https://wicg.github.io/document-picture-in-picture/
- MDN: classic Picture-in-Picture API
  - https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API
- MDN: `Permissions-Policy: picture-in-picture`
  - https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Permissions-Policy/picture-in-picture

## Re-check before changing behavior

- Browser/API behavior here is not fully stable across engines.
- If changing support policy, iframe usage, or opener/return-button behavior, re-check the MDN + spec links above first.
