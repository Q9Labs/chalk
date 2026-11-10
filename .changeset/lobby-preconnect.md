---
"@q9labsai/chalk-client": minor
---

Add `preconnect({ baseUrl, syncUrl })`. Call it while a person is on a lobby or pre-join screen: the browser opens its connection to the API and the Sync WebSocket upgrade runs, and the first Sync client built in the browser for that Sync URL adopts the open socket, so `join()` no longer waits for the upgrade. It asks for no grant, holds no seat, sends no frame and starts no media. Sync closes a socket that sends no hello within 5 s, so an unused socket is dropped after 4 s; call `preconnect` again as the person acts. It does nothing outside a browser page.
