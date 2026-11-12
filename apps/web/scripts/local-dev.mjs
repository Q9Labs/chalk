import { spawn } from "node:child_process";
import { createServer } from "vite";
import { localDashboard } from "./local-dashboard.mjs";

await run("pnpm", ["--filter", "@q9labsai/chalk-client", "build"]);
await run("pnpm", ["--filter", "@q9labsai/chalk-react", "build"]);
// This composition root is never imported by vite.config or the production build.
const server = await createServer({ plugins: [localDashboard()], server: { host: "127.0.0.1", port: Number(process.env.CHALK_DEV_WEB_PORT || "3070"), strictPort: true } });
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });

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
