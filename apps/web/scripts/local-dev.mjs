import { spawnCommand } from "../../../scripts/lib/platform.mjs";
import { createServer } from "vite";
import { localDashboard } from "./local-dashboard.mjs";

await run("pnpm", ["exec", "turbo", "run", "build", "--filter=@q9labsai/chalk-react..."]);
// This composition root is never imported by vite.config or the production build.
const server = await createServer({ plugins: [localDashboard()], server: { host: process.env.PUBLIC_ORIGIN ? "0.0.0.0" : "127.0.0.1", port: Number(process.env.CHALK_DEV_WEB_PORT || "3070"), strictPort: true } });
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, arguments_, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code ?? "an unknown status"}`));
    });
  });
}
