These frames were captured from the published `@q9labsai/chalk-client` packages
5.0.0 and 5.1.0 using their exported `V1SyncClient`, a recording WebSocket port,
and the placeholder token `published-regression-token`. Each capture starts the
client, disconnects its transport to trigger reconnect, then stops and restarts
it for an explicit retry. The fixture records the resulting URL path and all
three hello frames. Tests replace only the placeholder token.

The packages came from:

- https://registry.npmjs.org/@q9labsai/chalk-client/-/chalk-client-5.0.0.tgz
- https://registry.npmjs.org/@q9labsai/chalk-client/-/chalk-client-5.1.0.tgz

Their tarball SHA-256 values are recorded in `published-entry-hellos.json`.
Neither client sends an entry-generation query or an entered frame. The server
allocates and confirms a new generation for each legacy hello while retaining
the welcome shape these clients understand.
