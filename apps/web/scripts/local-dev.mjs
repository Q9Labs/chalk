import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;

await run("pnpm", ["--filter", "@q9labsai/chalk-client", "build"]);
await run("pnpm", ["--filter", "@q9labsai/chalk-react", "build"]);

const backend = start("node", ["scripts/local-chalk-backend.mjs"]);
const vite = start("pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", "3070"]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

backend.on("exit", (code, signal) => childExited("local Chalk backend", code, signal));
vite.on("exit", (code, signal) => childExited("Vite", code, signal));

function start(command, arguments_) {
  const child = spawn(command, arguments_, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code ?? "an unknown status"}`));
    });
  });
}

function childExited(name, code, signal) {
  if (stopping) return;
  process.exitCode = code ?? 1;
  console.error(`[chalk-local-dev] ${name} exited with ${signal ?? code ?? "an unknown status"}`);
  shutdown("SIGTERM");
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  if (signal === "SIGINT") process.exitCode = 130;
}
