import { check, save, waitFor } from "./runtime.mjs";

export function credentialExpiries(grant) {
  const mediaExpiry = Date.parse(grant.media.expires_at);
  const syncExpiry = Date.parse(grant.sync.expires_at);
  check(Number.isFinite(mediaExpiry) && Number.isFinite(syncExpiry), "Proof access grant is missing credential expiry timestamps");
  return { mediaExpiry, syncExpiry };
}

export async function waitForCredentialRefresh(run, refreshes, ready) {
  try {
    await waitFor("both clients' scheduled credential refresh", async () => refreshes.every((refresh) => refresh.count > 0 && refresh.latestExpiry > refresh.initialExpiry), 360_000, 1000, run.signal);
    await run.wait(Math.max(0, Math.max(...refreshes.map((refresh) => refresh.initialExpiry)) + 5000 - Date.now()));
    await ready();
  } finally {
    await save(`${run.directory}/credential-refresh.json`, refreshes);
  }
}
