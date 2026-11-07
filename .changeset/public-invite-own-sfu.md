---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react-native": minor
---

The public-invite client declares that it can run the own SFU. Arrivals, status polls, access refreshes and new Spaces send `X-Chalk-Media-Providers: cloudflare_sfu,chalk_sfu`, so a call on a Space that selects `chalk_sfu` joins the own SFU instead of Cloudflare. The React Native client already runs the own SFU grant through the shared media engine. Against an API that predates this, the header is ignored and the call stays on Cloudflare.

The React Native client also derives the Sync address for a prefixed environment API (`nightly-api` → `nightly-sync`) the way the web client does, so a nightly build reaches Sync instead of failing with `connection.sync_start_failed`.
