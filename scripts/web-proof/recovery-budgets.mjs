import { readFileSync } from "node:fs";

// Test-side only: read the production defaults, including constant aliases.
// A budget rename or nonconstant expression must fail loudly, not silently
// leave browser proofs using an obsolete timeout.
export function recoveryBudgets(source = readFileSync(new URL("../../sdks/typescript/client/src/connection/lifecycle.ts", import.meta.url), "utf8")) {
  function milliseconds(name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`Cyclic recovery budget ${name}`);
    seen.add(name);
    const value = new RegExp(`const ${name} = ([\\w]+);`).exec(source)?.[1];
    if (!value) throw new Error(`Cannot read lifecycle recovery budget ${name}`);
    return /^\d[\d_]*$/.test(value) ? Number(value.replaceAll("_", "")) : milliseconds(value, seen);
  }
  const syncBudget = /waitForSyncLive\(sync,\s*boundedInteger\(options\.recovery\?\.budgetMs,\s*(\w+)/.exec(source)?.[1];
  if (!syncBudget) throw new Error("Cannot read Sync recovery default");
  const syncMs = milliseconds(syncBudget);
  const mediaMs = milliseconds("RECOVERY_BUDGET_MS");
  return { syncMs, mediaMs, timeoutMs: Math.max(syncMs, mediaMs) + 15_000 };
}
