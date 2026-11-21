import assert from "node:assert/strict";
import { test } from "node:test";
import { postToOncall } from "./oncall-alert.mjs";

const post = (response) => postToOncall({ fetchImpl: async () => response, url: "https://example.invalid/secret", incidents: [{ id: "i", title: "t", severity: "high" }], drill: false });
const reply = (status, body) => new Response(body, { status });

test("a disabled Oncall task is named, never the secret URL", async () => {
  await assert.rejects(post(reply(409, JSON.stringify({ error: "hook_disabled" }))), { message: "Oncall webhook answered HTTP 409 (the Oncall task is disabled)" });
});

test("a refusal reports its status without reading the body", async () => {
  await assert.rejects(post({ ok: false, status: 502 }), { message: "Oncall webhook answered HTTP 502" });
  await assert.rejects(post(reply(500, JSON.stringify({ error: "Contains https://example.invalid/secret" }))), { message: "Oncall webhook answered HTTP 500" });
});

test("an accepted delivery returns", async () => {
  await post(reply(202, JSON.stringify({ deliveryId: "d" })));
});
