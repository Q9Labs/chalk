import * as SecureStore from "expo-secure-store";

const ARRIVAL_KEY_PREFIX = "chalk_mobile_public_arrival_v1.";
const ARRIVAL_INDEX_PREFIX = "chalk_mobile_public_arrival_index_v1.";

export type StoredSpaceArrival = {
  readonly arrivalHandle: string;
  readonly guestCredential: string;
  readonly slug: string;
  readonly spaceInviteToken: string;
};

/** The arrival this device holds for an invite, or undefined when there is none or the stored value is damaged. */
export async function loadArrival(spaceInviteToken: string): Promise<StoredSpaceArrival | undefined> {
  const handle = await SecureStore.getItemAsync(`${ARRIVAL_INDEX_PREFIX}${spaceInviteToken}`);
  if (!handle) return undefined;
  const value = await SecureStore.getItemAsync(`${ARRIVAL_KEY_PREFIX}${handle}`);
  const stored = value ? parseStoredArrival(value) : undefined;
  if (stored?.spaceInviteToken === spaceInviteToken) return stored;
  await clearArrivalByHandle(handle, spaceInviteToken);
  return undefined;
}

export async function persistArrival(value: StoredSpaceArrival): Promise<void> {
  await Promise.all([SecureStore.setItemAsync(`${ARRIVAL_KEY_PREFIX}${value.arrivalHandle}`, JSON.stringify(value)), SecureStore.setItemAsync(`${ARRIVAL_INDEX_PREFIX}${value.spaceInviteToken}`, value.arrivalHandle)]);
}

export async function clearArrival(value: StoredSpaceArrival): Promise<void> {
  await clearArrivalByHandle(value.arrivalHandle, value.spaceInviteToken);
}

async function clearArrivalByHandle(arrivalHandle: string, spaceInviteToken: string): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(`${ARRIVAL_KEY_PREFIX}${arrivalHandle}`), SecureStore.deleteItemAsync(`${ARRIVAL_INDEX_PREFIX}${spaceInviteToken}`)]);
}

function parseStoredArrival(json: string): StoredSpaceArrival | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return isStoredArrival(parsed) ? parsed : undefined;
  } catch {
    // Invalid device state is removed by the caller.
    return undefined;
  }
}

function isStoredArrival(value: unknown): value is StoredSpaceArrival {
  if (typeof value !== "object" || value === null) return false;
  if (!("arrivalHandle" in value) || !("guestCredential" in value) || !("slug" in value) || !("spaceInviteToken" in value)) return false;
  return typeof value.arrivalHandle === "string" && typeof value.guestCredential === "string" && typeof value.slug === "string" && typeof value.spaceInviteToken === "string";
}
