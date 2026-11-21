import assert from "node:assert/strict";
import test from "node:test";
import { readSignals } from "./listener-audio-check.mjs";

const window = { startTime: "2026-10-31T11:50:00.000Z", endTime: "2026-10-31T12:00:00.000Z" };
const reason = (body, status = 400) =>
  readSignals({ token: "fake-token", dataset: "synthetic-private-dataset", ...window, fetchImpl: async () => ({ ok: false, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }) }).then(
    () => assert.fail("expected a rejection"),
    (error) => error.message,
  );

test("a non-2xx Axiom answer names its reason, one line, with the dataset and token masked", async () => {
  assert.equal(
    await reason({ code: 400, message: "line: 1, col: 1: unable to find dataset 'synthetic-private-dataset'\n\n['synthetic-private-dataset']\n^^^", detail: { message: "unable to find dataset 'synthetic-private-dataset'" } }),
    "Axiom query answered HTTP 400: unable to find dataset '<dataset>'",
  );
  assert.equal(await reason({ code: 400, message: "invalid field: \"attributes.legacy_route\"\n\n['synthetic-private-dataset']\n| where ..." }), 'Axiom query answered HTTP 400: invalid field: "attributes.legacy_route"');
  assert.equal(await reason({ message: "credential fake-token in dataset synthetic-private-dataset" }), "Axiom query answered HTTP 400: credential <token> in dataset <dataset>");
});

test("a non-JSON or missing error body still fails on the status alone", async () => {
  assert.equal(await reason("<html>Bad Gateway</html>", 502), "Axiom query answered HTTP 502");
  await assert.rejects(readSignals({ token: "fake", dataset: "fake", ...window, fetchImpl: async () => ({ ok: false, status: 403 }) }), /^Error: Axiom query answered HTTP 403$/);
});
