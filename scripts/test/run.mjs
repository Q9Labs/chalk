import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const guard = new URL("./no-network.mjs", import.meta.url).href;
const child = spawn(command, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${guard}` },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
