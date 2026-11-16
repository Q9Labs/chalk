import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-file.mjs";

// Windows has no graceful process.kill(SIGTERM). A private, authenticated loopback request lets the owner clean up.
export async function openRuntimeControl(config, onStop) {
  const token = randomBytes(32).toString("hex");
  const path = join(config.runtimeRoot, "control.json");
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== "POST" || request.url !== "/stop" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(202).end();
    onStop();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  await writeJsonAtomic(path, { pid: process.pid, port: server.address().port, token }, { redacted: false });
  return {
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await unlink(path).catch(() => {});
    },
  };
}

export async function requestRuntimeStop(config, pid) {
  const record = JSON.parse(await readFile(join(config.runtimeRoot, "control.json"), "utf8"));
  if (record.pid !== pid || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.token !== "string") throw new Error("Runtime control does not match the owning supervisor");
  const response = await fetch(`http://127.0.0.1:${record.port}/stop`, { method: "POST", headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000) });
  if (response.status !== 202) throw new Error(`Runtime stop request failed: HTTP ${response.status}`);
}
