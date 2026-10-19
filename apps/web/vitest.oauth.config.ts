import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/{oauth,config,session,engine}.test.ts"], maxWorkers: 1 } });
