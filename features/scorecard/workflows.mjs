import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

export const root = resolve(import.meta.dirname, "../..");

// workflow parses one of the repository's GitHub Actions workflows.
export const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));

// smokeStep finds a step of the real-call proof's smoke job by name.
export const smokeStep = (proof, name) => proof.jobs.smoke.steps.find((item) => item.name === name);
