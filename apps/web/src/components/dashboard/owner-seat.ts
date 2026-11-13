import { readReloadRejoin, reloadRejoinAccess, reloadRejoinPresence, reloadRejoinStorageKey, writeReloadRejoin, type GetAccess, type SpaceClient } from "@q9labsai/chalk-client";
import { Schema } from "effect";

import type { OwnerAccessDTO } from "../../lib/dashboard/contracts";
import { act, clearOwnerSeats, DashboardRequestError, intentKey, readPage } from "../../lib/dashboard/client";
import { dashboardAccessFailure } from "../../lib/dashboard/owner-access";

const isOwnerReloadIntent = Schema.is(Schema.Struct({ ownerJoinKey: Schema.String.check(Schema.isUUID()), ownerUserId: Schema.String }));

type Snapshot = ReturnType<SpaceClient["getSnapshot"]>;
type Access = OwnerAccessDTO["access"];

/** Tab storage is optional: with it disabled the owner still joins and leaves, and only reload recovery is lost. */
function tabStorage(run: (storage: Storage) => void) {
  try {
    run(window.sessionStorage);
  } catch {
    // Storage may be disabled.
  }
}

function readTabItem(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The join key this tab already holds for the call, or a new one; `found` tells which. */
function openJoinKey(storageKey: string) {
  let joinKey = intentKey();
  let found = false;
  tabStorage((storage) => {
    const stored = storage.getItem(storageKey);
    found = stored !== null;
    joinKey = stored ?? joinKey;
    storage.setItem(storageKey, joinKey);
  });
  return { joinKey, found };
}

const isOpenConnection = ({ status }: Snapshot["connection"]) => status === "live" || status === "reconnecting";

function readOwnerReload(spaceId: string, userId: string) {
  try {
    const encoded = window.sessionStorage.getItem(reloadRejoinStorageKey);
    const marker = readReloadRejoin(window.sessionStorage, spaceId);
    const saved: unknown = encoded ? JSON.parse(encoded) : null;
    return marker && isOwnerReloadIntent(saved) && saved.ownerUserId === userId ? { episodeId: marker.episodeId, joinKey: saved.ownerJoinKey } : null;
  } catch {
    return null;
  }
}

/** Owner access for one call: `join` admits the owner, `refresh-access` renews the same seat. */
export function ownerAccess(spaceId: string, userId: string) {
  const joinStorageKey = `chalk.owner-join:${userId}:${spaceId}`;
  const episodeStorageKey = `${joinStorageKey}:episode`;
  const opened = openJoinKey(joinStorageKey);
  let joinKey = opened.joinKey;
  let joined = false;
  let current: Access | undefined;
  let ownerSeat: string | undefined;
  let deadlineCeiling: string | undefined;
  const listeners = new Set<() => void>();
  let recovery: ReturnType<typeof readOwnerReload> | undefined;
  let restoring: Promise<void> | undefined;
  const clearReload = () => {
    tabStorage((storage) => {
      storage.removeItem(reloadRejoinStorageKey);
      if (!joined) return;
      storage.removeItem(joinStorageKey);
      storage.removeItem(episodeStorageKey);
    });
    if (ownerSeat) {
      ownerSeat = undefined;
      void clearOwnerSeats().catch(() => console.warn(JSON.stringify({ event: "dashboard.seat_cleanup_failed" })));
    }
  };
  const rotateJoinKey = () => {
    joinKey = intentKey();
    tabStorage((storage) => {
      storage.setItem(joinStorageKey, joinKey);
      storage.removeItem(episodeStorageKey);
    });
  };
  const join = () => act("call", { action: "join", spaceId, idempotencyKey: joinKey });
  // A Leave can commit while its acknowledgement is lost; its seat then refuses the retained key.
  const joinOrRotate = () =>
    join().catch((error: unknown) => {
      if (!(error instanceof DashboardRequestError && error.code === "participant_not_active")) throw error;
      rotateJoinKey();
      return join();
    });
  // Without the current token the server replaces the media connection.
  const refresh = (replaceMediaConnection: boolean) => act("call", { action: "refresh-access", spaceId, joinKey, ...(ownerSeat ? { ownerSeat } : {}), ...(!replaceMediaConnection && current ? { currentMediaToken: current.media.token } : {}) });
  const restore = async () => {
    if (recovery === undefined) recovery = readOwnerReload(spaceId, userId);
    const saved = recovery;
    const pendingEpisode = readTabItem(episodeStorageKey);
    if (!saved && !pendingEpisode && !opened.found) return;
    const page = await readPage("call", { spaceId });
    if (saved && page.live?.id === saved.episodeId) joinKey = saved.joinKey;
    else if (!pendingEpisode || page.live?.id !== pendingEpisode) rotateJoinKey();
  };
  const requestAccess = async ({ reason, replaceMediaConnection }: Parameters<GetAccess>[0]) => {
    await (restoring ??= restore().catch((error) => {
      restoring = undefined;
      throw error;
    }));
    const { access, ownerSeat: sealedSeat, deadlineCeiling: ceiling } = await (reason === "join" ? joinOrRotate() : refresh(replaceMediaConnection));
    current = access;
    ownerSeat = sealedSeat;
    deadlineCeiling = ceiling;
    tabStorage((storage) => {
      storage.setItem(joinStorageKey, joinKey);
      storage.setItem(episodeStorageKey, access.subject.episode_id);
    });
    for (const listener of listeners) listener();
    return access;
  };
  const getAccess: GetAccess = (input) => requestAccess(input).catch(dashboardAccessFailure);
  const saveReload = (snapshot: Snapshot) => {
    if (!current || !isOpenConnection(snapshot.connection) || snapshot.connection.episodeEnded || snapshot.connection.removedByHost) return;
    const marker = { ...reloadRejoinAccess(current), space: spaceId, tenantId: current.subject.tenant_id, ...reloadRejoinPresence(snapshot, ""), ownerJoinKey: joinKey, ownerUserId: userId };
    tabStorage((storage) => writeReloadRejoin(storage, marker));
  };
  const observe = (snapshot: Snapshot) => {
    if (isOpenConnection(snapshot.connection)) joined = true;
  };
  /** A leave the server never acknowledged also ends in `left`, but the seat may still be live: keep the join key so a return reuses it. */
  const afterClose = ({ status, lastError }: Snapshot["connection"]) => {
    if (status === "left" && !lastError) clearReload();
  };
  return {
    getAccess,
    saveReload,
    clearReload,
    observe,
    afterClose,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportAccess: () => current,
    deadlineCeiling: () => deadlineCeiling,
    reportCredential: () => current?.media.token,
  };
}
