import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const whiteboardEntry = fileURLToPath(import.meta.resolve("@q9labsai/chalk-whiteboard/embedded"));
const source = join(dirname(whiteboardEntry), "chalk-whiteboard");
const destination = join(packageRoot, "embedded", "chalk-whiteboard");

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
