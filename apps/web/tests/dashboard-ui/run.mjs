import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "../../../..");
const require = createRequire(resolve(root, "apps/web/package.json"));
const temporary = await mkdtemp(resolve(tmpdir(), "chalk-dashboard-ui-"));
const children = new Set();
const owner = process.ppid;
const controller = new AbortController();
const abort = () => controller.abort(new Error("Dashboard UI run cancelled"));
process.on("SIGTERM", abort);
process.on("SIGINT", abort);
const deadline = setTimeout(abort, 10 * 60_000);
const watcher = setInterval(() => {
  try {
    process.kill(owner, 0);
  } catch {
    abort();
  }
}, 1000);

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", detached: true, ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function completed(child) {
  return new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => (code === 0 ? accept() : reject(new Error(`Child ${child.pid} exited ${code ?? signal}`))));
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
}

async function ready(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    controller.signal.throwIfAborted();
    if (child.exitCode !== null) throw new Error(`Server exited before ${url} was ready`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // Startup can briefly refuse connections; the bounded loop owns retries.
    }
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

try {
  // Refuse occupied ports instead of accidentally testing another worktree.
  for (const port of [3070, 3071]) {
    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise((accept, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(accept));
    });
  }
  const video = resolve(temporary, "session.mp4");
  await completed(start("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=1", "-t", "120", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]));
  const vite = start("pnpm", ["--filter", "web", "exec", "vite", "--host", "127.0.0.1", "--port", "3070", "--strictPort"]);
  await ready("http://127.0.0.1:3070/dashboard/sign-in", vite);
  const fixture = start(process.execPath, ["apps/web/tests/dashboard-ui/fixture-server.mjs"], { env: { ...process.env, FIXTURE_VIDEO: video } });
  await ready("http://127.0.0.1:3071/__fixture/log", fixture);
  await completed(start(process.execPath, ["apps/web/tests/dashboard-ui/checks.mjs", require.resolve("playwright"), "http://127.0.0.1:3071"]));
} finally {
  clearTimeout(deadline);
  clearInterval(watcher);
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
