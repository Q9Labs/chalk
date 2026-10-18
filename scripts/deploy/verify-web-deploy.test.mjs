import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { verifyWebDeploy } from "./verify-web-deploy.mjs";

const appLinkPages = {
  "/.well-known/apple-app-site-association": ["application/json", "{}"],
  "/.well-known/assetlinks.json": ["application/json", "[]"],
  "/space/": ["text/html", '<head><meta name="apple-itunes-app" content="app-id=1"></head>'],
};

function serveAppLinks(req, res) {
  const page = appLinkPages[req.url];
  if (!page) return false;
  res.writeHead(200, { "content-type": page[0] });
  res.end(page[1]);
  return true;
}

test("verifies the web revision and retained API health without the account proxy", async () => {
  const sha = "a".repeat(40);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (serveAppLinks(req, res)) return;
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
    assert.deepEqual(requests, [`/sw.js?cb=${sha}`, "/healthz", ...Object.keys(appLinkPages)]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("a correct marker cannot hide stale service-worker, unhealthy API or missing app-link evidence", async () => {
  const sha = "a".repeat(40);
  const cases = [
    { commit: "b".repeat(40), health: "ok", target: "nightly", message: /service worker has commit/ },
    { commit: sha, health: "unhealthy", target: "nightly", message: /API health did not report/ },
    { commit: sha, health: "ok", target: "production", message: /served web release mismatch/ },
    { commit: sha, health: "ok", target: "nightly", message: /apple-app-site-association must be served as JSON/ },
  ];
  for (const { commit, health, target, message } of cases) {
    const responses = { "/sw.js": { commitHash: commit }, "/healthz": { status: health }, "/release.json": { environment: target, commit: sha } };
    const server = createServer((req, res) => res.end(JSON.stringify(responses[new URL(req.url, "http://localhost").pathname])));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      await assert.rejects(verifyWebDeploy({ baseURL: origin, apiBaseURL: origin, expectedSHA: sha, expectedEnvironment: "nightly", deadlineMs: 2_000, retryDelayMs: 3_000 }), message);
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
  const responses = {
    "/sw.js": () => {
      workers += 1;
      return { commitHash: workers === 1 ? "b".repeat(40) : sha };
    },
    "/release.json": () => {
      markers += 1;
      return { environment: "nightly", commit: markers === 1 ? "b".repeat(40) : sha };
    },
  };
  const web = createServer((req, res) => serveAppLinks(req, res) || res.end(JSON.stringify(responses[new URL(req.url, "http://localhost").pathname]())));
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
