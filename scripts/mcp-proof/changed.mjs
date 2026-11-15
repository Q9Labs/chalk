// Decides whether Promote runs the MCP production check: only when the release changes MCP or what the check exercises.
//   node scripts/mcp-proof/changed.mjs --previous <sha> --target <sha>
// Prints "changed=true|false" and the reason; with GITHUB_OUTPUT set it also writes both there.
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decide } from "./changed-paths.mjs";

const { values } = parseArgs({ options: { previous: { type: "string" }, target: { type: "string" } } });
const { changed, reason } = decide(values);
console.log(`changed=${changed}\nreason=${reason}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nreason=${reason}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `MCP production check: ${reason}\n`);
