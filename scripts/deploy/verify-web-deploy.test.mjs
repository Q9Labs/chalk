import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { parseArguments, verifyWebDeploy } from "./verify-web-deploy.mjs";

const fullSHA = "040a7c52698f8cf9b87b0ef48f918b681de9bc35";
let baseURL;
let serviceWorkerRequests = 0;
let localChalkHealthRequests = 0;
let diagnosticsDocumentRequests = 0;
let staleServiceWorkerResponses = 0;
let server;

before(async () => {
  server = createServer(handleRequest);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  baseURL = `http://127.0.0.1:${address.port}`;
});

const requestHandlers = new Map([
  ["/sw.js", respondServiceWorker],
  ["/api/healthz", respondBoundaryHealth],
  ["/_internal/episode-diagnostics/chalkdiag%3Av1%3Aproduction%3Adiag01", respondDiagnosticsGateway],
  ["/developer/episode-diagnostics/chalk.episode%3A00000000-0000-4000-8000-000000000001", respondDiagnosticsDocument],
  ["/local-chalk/health", respondLocalChalkHealth],
]);

function handleRequest(request, response) {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const handler = requestHandlers.get(pathname);
  if (handler) return handler(response);
  response.writeHead(404);
  response.end();
}

function respondServiceWorker(response) {
  serviceWorkerRequests += 1;
  const commitHash = staleServiceWorkerResponses > 0 ? fullSHA.slice(0, 7) : fullSHA;
  staleServiceWorkerResponses = Math.max(0, staleServiceWorkerResponses - 1);
  response.writeHead(200, { "Content-Type": "text/javascript" });
  response.end(`const BUILD_META = { "commitHash": "${commitHash}" };`);
}

function respondBoundaryHealth(response) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ status: "ok", dependencies: { account_api: "ok" } }));
}

function respondDiagnosticsGateway(response) {
  response.writeHead(401, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { code: "access.unauthenticated" } }));
}

function respondDiagnosticsDocument(response) {
  diagnosticsDocumentRequests += 1;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Chalk</title>");
}

function respondLocalChalkHealth(response) {
  localChalkHealthRequests += 1;
  response.writeHead(200);
  response.end("ok");
}

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("verifies the Pages asset, account boundary, and diagnostics gateway", async () => {
  serviceWorkerRequests = 0;
  localChalkHealthRequests = 0;
  diagnosticsDocumentRequests = 0;
  await verifyWebDeploy({ baseURL, expectedSHA: fullSHA, deadlineMs: 500, retryDelayMs: 5, requestTimeoutMs: 200 });
  assert.equal(serviceWorkerRequests, 1);
  assert.equal(localChalkHealthRequests, 0);
  assert.equal(diagnosticsDocumentRequests, 1);
});

test("retries stale production edges and checks local Chalk health", async () => {
  staleServiceWorkerResponses = 1;
  serviceWorkerRequests = 0;
  localChalkHealthRequests = 0;
  diagnosticsDocumentRequests = 0;
  await verifyWebDeploy({ baseURL, expectedSHA: fullSHA, production: true, deadlineMs: 500, retryDelayMs: 5, requestTimeoutMs: 50 });
  assert.equal(serviceWorkerRequests, 2);
  assert.equal(localChalkHealthRequests, 1);
  assert.equal(diagnosticsDocumentRequests, 1);
});

test("parses the production CLI flag and rejects unknown flags", () => {
  assert.deepEqual(parseArguments(["https://chalkmeet.com", fullSHA, "--production"]), {
    baseURL: "https://chalkmeet.com",
    expectedSHA: fullSHA,
    production: true,
  });
  assert.throws(() => parseArguments(["https://chalkmeet.com", fullSHA, "--force"]), /Usage:/);
});

test("requires the verifier input and service-worker metadata to use the full SHA", async () => {
  assert.throws(() => parseArguments([baseURL, fullSHA.slice(0, 7)]), /Invalid commit SHA/);
  staleServiceWorkerResponses = 1;
  await assert.rejects(verifyWebDeploy({ baseURL, expectedSHA: fullSHA, deadlineMs: 1, retryDelayMs: 0, requestTimeoutMs: 50 }), /service worker has commit unknown/);
});
