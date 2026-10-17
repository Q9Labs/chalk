import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { verifyWebDeploy } from "./verify-web-deploy.mjs";

test("verifies the web revision and retained API health without the account proxy", async () => {
  const sha = "a".repeat(40);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith("/sw.js")) res.end(JSON.stringify({ commitHash: sha }));
    else if (req.url === "/healthz") res.end(JSON.stringify({ status: "ok" }));
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await verifyWebDeploy({ baseURL: origin, apiBaseURL: origin, expectedSHA: sha, deadlineMs: 0 });
    assert.deepEqual(requests, [`/sw.js?cb=${sha}`, "/healthz"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
