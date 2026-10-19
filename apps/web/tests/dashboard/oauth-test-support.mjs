import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/** Claims rejected by both the direct verifier and the production workerd adapter. */
export function invalidIdentityClaims() {
  const now = Math.floor(Date.now() / 1000);
  return [{ iss: "https://evil.example" }, { aud: "wrong" }, { exp: 1 }, { exp: undefined }, { exp: "later" }, { iat: undefined }, { iat: "now" }, { iat: now + 3600 }, { iat: now + 30, exp: now + 10 }, { nonce: "wrong" }];
}

/** Stop only the Pages process group and watchdog owned by this fixture run. */
export async function stopFixturePages(pages, watchdog, deadline) {
  clearTimeout(deadline);
  watchdog?.kill("SIGTERM");
  if (!pages?.pid) return;
  try {
    process.kill(-pages.pid, "SIGTERM");
  } catch {}
  await Promise.race([once(pages, "exit"), delay(3000)]);
  try {
    process.kill(-pages.pid, "SIGKILL");
  } catch {}
}
