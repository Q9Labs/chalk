import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/{oauth,oauth-handler,config,session}.test.ts"], maxWorkers: 1 } });
