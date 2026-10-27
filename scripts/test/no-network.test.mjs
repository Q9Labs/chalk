import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
for (const [transport, request] of [
  ["fetch", 'await fetch("https://example.com").catch(() => {});'],
  ["HTTP", 'const { get } = await import("node:http"); try { get("http://example.com").on("error", () => {}); } catch {}'],
  ["HTTPS", 'const { get } = await import("node:https"); try { get("https://example.com").on("error", () => {}); } catch {}'],
  ["TCP", 'const { connect } = await import("node:net"); try { connect(443, "example.com").on("error", () => {}); } catch {}'],
  ["IPv4", 'await fetch("http://192.0.2.1").catch(() => {});'],
  ["IPv6", 'await fetch("http://[2001:db8::1]").catch(() => {});'],
]) {
  test(`blocks ${transport} even when the caller catches the error`, () => {
    const result = spawnSync(process.execPath, [runner, process.execPath, "--input-type=module", "--eval", request], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unit test blocked a real network connection/);
  });
}

for (const [name, options] of [
  ["localhost", { host: "localhost", port: 0 }],
  ["IPv6 loopback", { host: "::1", port: 0 }],
  ["default host", { port: 0 }],
  ["null host", { host: null, port: 0 }],
  ["Unix socket", { path: "/tmp/chalk-network-guard-missing.sock" }],
]) {
  test(`allows ${name}`, () => {
    const request = `import { connect } from "node:net"; connect(${JSON.stringify(options)}).on("error", () => {}).on("connect", function () { this.destroy(); });`;
    const result = spawnSync(process.execPath, [runner, process.execPath, "--input-type=module", "--eval", request], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("allows real loopback HTTP, but blocks a redirect to a remote host", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      process.execPath,
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    const server = createServer((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: "https://example.com" });
      response.end("local");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = "http://127.0.0.1:" + server.address().port;
      assert.equal(await (await fetch(url)).text(), "local");
      console.log("loopback passed");
      await fetch(url + "/redirect").catch(() => {});
    } finally { server.closeAllConnections(); server.close(); }
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.match(result.stdout, /loopback passed/);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unit test blocked a real network connection to example.com/);
});
