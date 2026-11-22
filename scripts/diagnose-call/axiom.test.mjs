import assert from "node:assert/strict";
import { test } from "node:test";
import { axiom } from "./axiom.mjs";

const query = { token: "t", dataset: "private-dataset-name", apl: "where true", start: 0, end: 1 };

test("an Axiom refusal names the status only, never the dataset or the response text", async () => {
  const refuse = async () => new Response("dataset private-dataset-name not found", { status: 403 });
  await assert.rejects(axiom(query, refuse), (error) => error.message === "Axiom answered HTTP 403");
});

test("a row the API relay logged for another producer reads as that producer's", async () => {
  const answer = async () => Response.json({ matches: [{ _time: "2026-01-01T00:00:00Z", _rowId: "r", data: { service: "chalk-api", evidence_service: "chalk-sync", name: "sync.episode.ended" } }] });
  const { rows } = await axiom(query, answer);
  assert.equal(rows[0].service, "chalk-sync");
  assert.equal(rows[0].name, "sync.episode.ended");
});
