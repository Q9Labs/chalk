import { loadSession } from "./dashboard/client";

/** The site session supplies a display name, never engine account credentials. */
export async function getAccount() {
  return (await loadSession()).profile;
}
