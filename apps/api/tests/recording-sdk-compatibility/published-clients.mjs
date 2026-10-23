import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Invoked by the PostgreSQL HTTP integration test while its real server is live.
const fixtures = JSON.parse(process.env.CHALK_COMPAT_RECORDINGS);
for (const version of ["5.0.0", "5.1.0"]) {
  const directory = resolve(process.env.CHALK_RECORDING_PUBLISHED_CLIENTS, version);
  const require = createRequire(resolve(directory, "package.json"));
  const clientPath = require.resolve("@q9labsai/chalk-client/effect");
  const clientRequire = createRequire(clientPath);
  const manifest = JSON.parse(await readFile(resolve(directory, "node_modules/@q9labsai/chalk-client/package.json"), "utf8"));
  assert.equal(manifest.version, version);
  const { createChalkEffectClient } = await import(pathToFileURL(clientPath).href);
  const { Effect, Exit } = await import(pathToFileURL(clientRequire.resolve("effect")).href);
  const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: process.env.CHALK_COMPAT_API_URL, auth: { type: "bearer", token: process.env.CHALK_COMPAT_API_KEY } }));
  for (const fixture of fixtures) {
    const recording = await Effect.runPromise(client.recordings.getRecording({ params: { tenant_id: process.env.CHALK_COMPAT_TENANT_ID, recording_id: fixture.id } }));
    assert.equal(recording.export.status, fixture.status);
  }
  const list = await Effect.runPromise(client.recordings.listRecordings({ params: { tenant_id: process.env.CHALK_COMPAT_TENANT_ID }, query: {} }));
  assert.equal(list.recordings.length, fixtures.length);
  for (const fixture of fixtures) assert.equal(list.recordings.find((recording) => recording.id === fixture.id)?.export.status, fixture.status);
  console.log(`PASS published ${version}: ${fixtures.length} real getRecording responses and mixed listRecordings response decoded`);
  // Reintroduce only the rejected wire value in a real response. One changed
  // item must poison a whole old-client list, so this proof detects the regression.
  const incompatible = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: process.env.CHALK_COMPAT_API_URL,
      auth: { type: "bearer", token: process.env.CHALK_COMPAT_API_KEY },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body = await response.json();
        const recording = body.recordings ? body.recordings.find((item) => item.id === fixtures[0].id) : body;
        recording.export.status = "expired";
        return Response.json(body, { status: response.status });
      },
    }),
  );
  assert(Exit.isFailure(await Effect.runPromise(Effect.exit(incompatible.recordings.getRecording({ params: { tenant_id: process.env.CHALK_COMPAT_TENANT_ID, recording_id: fixtures[0].id } })))));
  assert(Exit.isFailure(await Effect.runPromise(Effect.exit(incompatible.recordings.listRecordings({ params: { tenant_id: process.env.CHALK_COMPAT_TENANT_ID }, query: {} })))));
  console.log(`PASS published ${version}: negative controls reject expired in a single response and in one mixed-list item`);
}
