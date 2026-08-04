import { spawn } from "node:child_process";

await run("pnpm", ["--filter", "@q9labsai/chalk-client", "build"]);
await run("pnpm", ["--filter", "@q9labsai/chalk-react", "build"]);
await run("pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", "3070"]);

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
