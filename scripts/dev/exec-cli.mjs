import { fileURLToPath } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { executeDevCommand } from "./exec.mjs";

const [service, ...command] = process.argv.slice(2);
const config = resolveDevConfig({ root: fileURLToPath(new URL("../..", import.meta.url)) });
process.exitCode = await executeDevCommand(service, command, { config });
