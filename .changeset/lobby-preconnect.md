---
"@q9labsai/chalk-client": minor
---

Add `preconnect({ baseUrl, syncUrl })`. Call it while a person is on a lobby or pre-join screen and the browser opens its TCP and TLS connections to the API and Sync origins, so `join()` skips those round trips. It sends no request, asks for no grant, holds no seat and starts no media. It does nothing outside a browser page.
