import { loadConfig, renderCloudInit } from "./config.ts";

process.stdout.write(await renderCloudInit(await loadConfig()));
