#!/usr/bin/env node
// Are the Types Wrong? on every published package, with the repository's .attw.json.
import path from "node:path";
import { runCommand } from "../lib/platform.mjs";
import { repositoryRoot } from "../lib/repository.mjs";

const config = path.join(repositoryRoot, ".attw.json");
process.exit(runCommand("pnpm", ["--filter", "./packages/*", "--filter", "./sdks/typescript/*", "exec", "attw", "--pack", "--config-path", config], { cwd: repositoryRoot }));
