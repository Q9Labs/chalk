import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function startCallHarness(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  if (address === null || typeof address === "string") throw new Error("Call harness did not allocate a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const cacheDir = await mkdtemp(join(tmpdir(), "chalk-call-harness-"));

  // The stdin lease closes even if the owning worker is killed; the whole process group then exits.
  const runner = String.raw`
import { spawn } from 'node:child_process';
const stop = () => process.kill(-process.pid, 'SIGTERM');
process.stdin.resume();
process.stdin.once('end', stop);
setTimeout(stop, 360_000).unref();
const vite = spawn('pnpm', ['exec', 'vite', '--config', 'vite.call-states.config.ts', '--port', process.argv[1], '--strictPort'], { stdio: ['ignore', 'ignore', 'inherit'] });
vite.once('error', error => { console.error(error); stop(); });
vite.once('exit', stop);
`;
  const server = spawn(process.execPath, ["--input-type=module", "-e", runner, String(address.port)], { cwd: fileURLToPath(new URL("../..", import.meta.url)), detached: true, env: { ...process.env, CHALK_CALL_HARNESS_CACHE_DIR: cacheDir }, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  let spawnError: Error | undefined;
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  server.once("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      server.stdin.end();
      const forceStop = setTimeout(() => {
        if (server.pid && server.exitCode === null && server.signalCode === null) process.kill(-server.pid, "SIGKILL");
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(forceStop);
        await rm(cacheDir, { recursive: true, force: true });
      }
    })();
    return stopping;
  }

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Call harness exited: ${server.exitCode ?? server.signalCode}\n${stderr}`);
      const ready = await fetch(`${origin}/call-states.html`, { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) return { origin, stop };
      await delay(200);
    }
    throw new Error(`Call harness did not become ready: ${origin}\n${stderr}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
