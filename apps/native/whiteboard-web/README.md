# Chalk Whiteboard WebView Host

Purpose: run Excalidraw + `@q9labs/chalk-whiteboard/collab` inside a WebView (iOS + Android), with a strict JSON bridge to native.

This is **not** the web product UI. It's a tiny host page meant to be bundled into native apps as static assets.

## Build

From repo root:

```bash
bun install
bash apps/native/whiteboard-web/build.sh
```

Output: `apps/native/whiteboard-web/dist`

## Bridge contract (overview)

Inbound (native -> WebView):
- `wb.init`
- `wb.snapshot`
- `wb.update`
- `wb.cursor`
- `wb.permission`
- `wb.presignUpload.result`
- `wb.presignDownload.result`

Outbound (WebView -> native):
- `wb.sendUpdateV2`
- `wb.sendCursor`
- `wb.requestSync`
- `wb.sendClear`
- `wb.presignUpload`
- `wb.presignDownload`

All messages are JSON strings of shape:
`{ "type": "<string>", "payload": { ... }, "requestId"?: "<string>" }`

Native must provide a JS global for outbound:
- Prefer: `window.ChalkNativeBridge.postMessage(string)`
- iOS fallback: `window.webkit.messageHandlers.chalk.postMessage(string)`

Native sends inbound by calling:
- `window.__chalkNativeOnMessage(string)`

