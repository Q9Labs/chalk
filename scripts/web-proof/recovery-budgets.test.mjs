import assert from "node:assert/strict";
import test from "node:test";
import { recoveryBudgets } from "./recovery-budgets.mjs";

test("browser recovery waits outlive actual Sync and media budgets", () => {
  const budgets = recoveryBudgets();
  assert.equal(budgets.syncMs, 60_000);
  assert.ok(budgets.timeoutMs > budgets.syncMs);
  assert.ok(budgets.timeoutMs > budgets.mediaMs);
});

test("the proof follows a media budget change without another hardcoded timeout", () => {
  assert.deepEqual(recoveryBudgets("const SYNC_RECOVERY_BUDGET_MS = WAIT_MS; const RECOVERY_BUDGET_MS = WAIT_MS; const WAIT_MS = 60_000;"), { syncMs: 60_000, mediaMs: 60_000, timeoutMs: 75_000 });
  assert.throws(() => recoveryBudgets(""), /Cannot read/);
});
