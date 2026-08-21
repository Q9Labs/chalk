# Chalk main-flow dogfood session log

Date: 2026-08-14

## Scope

Dogfood the first-party web flow from landing page through account creation,
Space creation, joining, and leaving. Keep all work local. Do not push.

## Milestones

- The local launcher initially failed to discover the canonical Episode broker
  because a tracked legacy broker config was also present. Discovery now selects
  the `CHALK_SPACE_ID` binding and has a regression test.
- The local bootstrap had drifted from the API contract. Space and API-key
  writes now send required idempotency keys, and API-key writes use a fresh
  runtime-specific key on every start.
- The local system token was rejected by API-key recent-auth validation. Internal
  System principals now bypass the Dashboard-only recent-auth step, with a Go
  regression test.
- The web dev boundary used the default API port instead of the configured local
  API origin. The launcher now passes that origin to the web child and tests it.
- The optional local observability image was unavailable, so the dev resource
  manager gained an explicit local opt-out. The dogfood runtime uses that opt-out
  and keeps the real API, Sync, broker, and web paths enabled.
- The first live-entry pass found two product issues: Dashboard join failures
  could leave a live participant behind, and the web client could hang on a
  failed join. The repair now cleans up failed server-side grants, surfaces
  nested API errors, resets the join guard correctly, and keeps the local API,
  Sync, and SFU endpoints paired.
- A clean browser rerun then found that React StrictMode was releasing a fresh
  Dashboard participant during its development mount probe. The Space cleanup
  now defers release by one tick and cancels it when the probe remounts. The
  repaired flow reached live Chalk, sent chat, opened People, exercised media
  controls, and left successfully with no browser warnings or errors.

## Runtime notes

The current local run uses API port 18080 and broker port 8877 because 8080 is
occupied by an unrelated SSH tunnel and 8787 is occupied by another local app.
The reusable `chalk-postgres` container was restarted after local Sync retries
made its endpoint unresponsive. No production systems were touched.

## Pending

Complete and validate the final clean browser recording, upload only that clean
recording, verify the public link, run the quality gate, and clean up owned
processes.
