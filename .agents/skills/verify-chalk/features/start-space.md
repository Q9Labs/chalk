# Start a Space as a guest

A person opens `/space/`, types a name, and joins. Chalk creates a new Space and Episode for them and shows a link they can share. Another person opens that link to join them.

## Sub-features

- `start-create` creates a Space from the `/space/` page (`POST /v1/public/spaces` answers 201).
- `start-link` shows the call link and lets the creator close it (`Close call link`).
- `start-share` admits a second person who opens the creator's page URL.

## How to get to it (user POV)

- Open `<PUBLIC_ORIGIN>/space/`. Type a name in `Your name` and choose `Join call`.

## Driving it with Playwright (tests/board.e2e.ts pattern)

Preconditions:

- `pnpm dev:doctor` reports `"ok": true`. The web origin is `localhost` or HTTPS.

- **Create.** Go to `/space/`, run `getByLabel("Your name", { exact: true }).fill("BoardA")`, wait for the response `POST /v1/public/spaces`, click `Join call`. The response status is 201 and `Video tile for BoardA` appears. Exactly one tile matches `/^Video tile for /`.
- **Close the link banner.** Click `Close call link`.
- **Share.** Open `page.url()` in a second context, fill `Your name` with `BoardB`, click `Join call`. Both pages show two tiles.

## Gotchas

- The journey needs the Space-creation endpoint to accept anonymous requests. If the local API rejects it, report the status and body. Do not fall back to the seeded invite and call it verified.
- The `verify-chalk` lane did not drive this journey. The steps come from `tests/board.e2e.ts`.
