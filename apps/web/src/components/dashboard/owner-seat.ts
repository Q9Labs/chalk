import { readReloadRejoin, reloadRejoinAccess, reloadRejoinPresence, reloadRejoinStorageKey, writeReloadRejoin, type GetAccess, type SpaceClient } from "@q9labsai/chalk-client";
import { Schema } from "effect";

import type { OwnerAccessDTO } from "../../lib/dashboard/contracts";
import { act, clearOwnerSeats, DashboardRequestError, intentKey, readPage } from "../../lib/dashboard/client";
import { dashboardAccessFailure } from "../../lib/dashboard/owner-access";

const isOwnerReloadIntent = Schema.is(Schema.Struct({ ownerJoinKey: Schema.String.check(Schema.isUUID()), ownerUserId: Schema.String }));

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
  let joinKey = intentKey();
  let hasStoredJoinKey = false;
  try {
    const storedJoinKey = window.sessionStorage.getItem(joinStorageKey);
    hasStoredJoinKey = storedJoinKey !== null;
    joinKey = storedJoinKey ?? joinKey;
    window.sessionStorage.setItem(joinStorageKey, joinKey);
  } catch {
    // The pending-seat lease still covers browsers with tab storage disabled.
  }
  const episodeStorageKey = `${joinStorageKey}:episode`;
  let joined = false;
  let current: OwnerAccessDTO["access"] | undefined;
  let ownerSeat: string | undefined;
  let deadlineCeiling: string | undefined;
  const listeners = new Set<() => void>();
  let recovery: ReturnType<typeof readOwnerReload> | undefined;
  let restoring: Promise<void> | undefined;
  const clearReload = () => {
    try {
      window.sessionStorage.removeItem(reloadRejoinStorageKey);
      if (joined) {
        window.sessionStorage.removeItem(joinStorageKey);
        window.sessionStorage.removeItem(episodeStorageKey);
      }
    } catch {
      // Storage may be disabled; intentional leave must still work.
    }
    if (ownerSeat) {
      ownerSeat = undefined;
      void clearOwnerSeats().catch(() => console.warn(JSON.stringify({ event: "dashboard.seat_cleanup_failed" })));
    }
  };
  const rotateJoinKey = () => {
    joinKey = intentKey();
    try {
      window.sessionStorage.setItem(joinStorageKey, joinKey);
      window.sessionStorage.removeItem(episodeStorageKey);
    } catch {
      /* The old seat is terminal even without tab storage. */
    }
  };
  const join = () => act("call", { action: "join", spaceId, idempotencyKey: joinKey });
  const restore = async () => {
    if (recovery === undefined) recovery = readOwnerReload(spaceId, userId);
    const saved = recovery;
    let pendingEpisode: string | null = null;
    try {
      pendingEpisode = window.sessionStorage.getItem(episodeStorageKey);
    } catch {
      /* Tab storage is optional. */
    }
    if (!saved && !pendingEpisode && !hasStoredJoinKey) return;
    const page = await readPage("call", { spaceId });
    if (saved && page.live?.id === saved.episodeId) joinKey = saved.joinKey;
    else if (!pendingEpisode || page.live?.id !== pendingEpisode) rotateJoinKey();
  };
  const requestAccess = async ({ reason, replaceMediaConnection }: Parameters<GetAccess>[0]) => {
    await (restoring ??= restore().catch((error) => {
      restoring = undefined;
      throw error;
    }));
    const {
      access,
      ownerSeat: sealedSeat,
      deadlineCeiling: ceiling,
    } = reason === "join"
      ? // A Leave can commit while its acknowledgement is lost; its seat then refuses the retained key.
        await join().catch((error: unknown) => {
          if (!(error instanceof DashboardRequestError && error.code === "participant_not_active")) throw error;
          rotateJoinKey();
          return join();
        })
      : // Without the current token the server replaces the media connection.
        await act("call", { action: "refresh-access", spaceId, joinKey, ...(ownerSeat ? { ownerSeat } : {}), ...(!replaceMediaConnection && current ? { currentMediaToken: current.media.token } : {}) });
    current = access;
    ownerSeat = sealedSeat;
    deadlineCeiling = ceiling;
    try {
      window.sessionStorage.setItem(joinStorageKey, joinKey);
      window.sessionStorage.setItem(episodeStorageKey, access.subject.episode_id);
    } catch {
      /* The lease still covers pending admission. */
    }
    for (const listener of listeners) listener();
    return access;
  };
  const getAccess: GetAccess = (input) => requestAccess(input).catch(dashboardAccessFailure);
  const saveReload = (snapshot: ReturnType<SpaceClient["getSnapshot"]>) => {
    if (!current || (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") || snapshot.connection.episodeEnded || snapshot.connection.removedByHost) return;
    const marker = {
      ...reloadRejoinAccess(current),
      space: spaceId,
      tenantId: current.subject.tenant_id,
      ...reloadRejoinPresence(snapshot, ""),
      ownerJoinKey: joinKey,
      ownerUserId: userId,
    };
    try {
      writeReloadRejoin(window.sessionStorage, marker);
    } catch {
      // Reload recovery is unavailable with tab storage disabled.
    }
  };
  const observe = (snapshot: ReturnType<SpaceClient["getSnapshot"]>) => {
    if (snapshot.connection.status === "live" || snapshot.connection.status === "reconnecting") joined = true;
  };
  /** A leave the server never acknowledged also ends in `left`, but the seat may still be live: keep the join key so a return reuses it. */
  const afterClose = ({ status, lastError }: ReturnType<SpaceClient["getSnapshot"]>["connection"]) => {
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
