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
    await verifyWebDeploy({ baseURL: origin, apiBaseURL: origin, expectedSHA: sha, deadlineMs: 2_000 });
    assert.deepEqual(requests, [`/sw.js?cb=${sha}`, "/healthz"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a correct marker cannot hide stale service-worker or unhealthy API evidence", async () => {
  const sha = "a".repeat(40);
  for (const failure of ["worker", "api", "marker"]) {
    const server = createServer((req, res) => {
      if (req.url.startsWith("/sw.js")) res.end(JSON.stringify({ commitHash: failure === "worker" ? "b".repeat(40) : sha }));
      else if (req.url === "/healthz") res.end(JSON.stringify({ status: failure === "api" ? "unhealthy" : "ok" }));
      else if (req.url === "/release.json") res.end(JSON.stringify({ environment: failure === "marker" ? "production" : "nightly", commit: sha }));
      else res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const message = { worker: /service worker has commit/, api: /API health did not report/, marker: /served web release mismatch/ }[failure];
      await assert.rejects(verifyWebDeploy({ baseURL: origin, apiBaseURL: origin, expectedSHA: sha, expectedEnvironment: "nightly", deadlineMs: 50, retryDelayMs: 25 }), message);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("retries propagation and checks the explicitly selected target API", async () => {
  const sha = "a".repeat(40);
  let workers = 0;
  let health = 0;
  let markers = 0;
  const api = createServer((req, res) => {
    assert.equal(req.url, "/healthz");
    health += 1;
    res.end(JSON.stringify({ status: health === 1 ? "unhealthy" : "ok" }));
  });
  const web = createServer((req, res) => {
    if (req.url.startsWith("/sw.js")) {
      workers += 1;
      res.end(JSON.stringify({ commitHash: workers === 1 ? "b".repeat(40) : sha }));
    } else if (req.url === "/release.json") {
      markers += 1;
      res.end(JSON.stringify({ environment: "nightly", commit: markers === 1 ? "b".repeat(40) : sha }));
    } else res.writeHead(404).end();
  });
  await Promise.all([api, web].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  try {
    await verifyWebDeploy({ baseURL: `http://127.0.0.1:${web.address().port}`, apiBaseURL: `http://127.0.0.1:${api.address().port}`, expectedSHA: sha, expectedEnvironment: "nightly", deadlineMs: 2_000, retryDelayMs: 1 });
    assert.equal(workers, 4);
    assert.equal(health, 3);
    assert.equal(markers, 2);
  } finally {
    await Promise.all([api, web].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
