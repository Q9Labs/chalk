import { save, waitFor } from "./runtime.mjs";

export async function waitForCredentialRefresh(run, refreshes, ready) {
  try {
    await waitFor("both clients' scheduled credential refresh", async () => refreshes.every((refresh) => refresh.count > 0 && refresh.latestExpiry > refresh.initialExpiry), 360_000, 1000, run.signal);
    await run.wait(Math.max(0, Math.max(...refreshes.map((refresh) => refresh.initialExpiry)) + 5000 - Date.now()));
    await ready();
  } finally {
    await save(`${run.directory}/credential-refresh.json`, refreshes);
  }
}
