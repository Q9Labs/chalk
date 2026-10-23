import { readReloadRejoin, reloadRejoinAccess, reloadRejoinStorageKey, writeReloadRejoin, type GetAccess, type SpaceClient } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
import { Chalk } from "@q9labsai/chalk-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { OwnerAccessDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { SiteRoot, useSiteTheme } from "../site/theme";
import { useLoad, useSession } from "./AppShell";
import { ErrorPanel } from "./kit";

const ownerReloadIntent = z.object({ ownerJoinKey: z.uuid() });

function readOwnerReload(spaceId: string) {
  try {
    const encoded = window.sessionStorage.getItem(reloadRejoinStorageKey);
    const marker = readReloadRejoin(window.sessionStorage, spaceId);
    const saved = encoded ? ownerReloadIntent.safeParse(JSON.parse(encoded)) : null;
    return marker && saved?.success ? { episodeId: marker.episodeId, joinKey: saved.data.ownerJoinKey } : null;
  } catch {
    return null;
  }
}

/** Owner access for one call: `join` admits the owner, `refresh-access` renews the same seat. */
function ownerAccess(spaceId: string) {
  let joinKey = intentKey();
  let current: OwnerAccessDTO["access"] | undefined;
  let recovery: ReturnType<typeof readOwnerReload> | undefined;
  let restoring: Promise<void> | undefined;
  const clearReload = () => {
    try {
      window.sessionStorage.removeItem(reloadRejoinStorageKey);
    } catch {
      // Storage may be disabled; intentional leave must still work.
    }
  };
  const restore = async () => {
    if (recovery === undefined) recovery = readOwnerReload(spaceId);
    const saved = recovery;
    if (!saved) return;
    const page = await readPage("call", { spaceId });
    if (page.live?.id === saved.episodeId) joinKey = saved.joinKey;
  };
  const getAccess: GetAccess = async ({ reason, replaceMediaConnection }) => {
    await (restoring ??= restore().catch((error) => {
      restoring = undefined;
      throw error;
    }));
    const { access } =
      reason === "join"
        ? await act("call", { action: "join", spaceId, idempotencyKey: joinKey })
        : // Without the current token the server replaces the media connection.
          await act("call", { action: "refresh-access", spaceId, ...(!replaceMediaConnection && current ? { currentMediaToken: current.media.token } : {}) });
    current = access;
    return access;
  };
  const saveReload = (snapshot: ReturnType<SpaceClient["getSnapshot"]>) => {
    if (!current || (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") || snapshot.connection.episodeEnded || snapshot.connection.removedByHost) return;
    const marker = {
      ...reloadRejoinAccess(current),
      space: spaceId,
      tenantId: current.subject.tenant_id,
      displayName: snapshot.self.displayName ?? "",
      microphone: snapshot.media.local.microphone.state === "enabled",
      camera: snapshot.media.local.camera.state === "enabled",
      ownerJoinKey: joinKey,
    };
    try {
      writeReloadRejoin(window.sessionStorage, marker);
    } catch {
      // Reload recovery is unavailable with tab storage disabled.
    }
  };
  return { getAccess, saveReload, clearReload };
}

/** The call screen for the call's owner, through the React SDK's own call UI. */
export function OwnerCall({ spaceId }: { readonly spaceId: string }) {
  const { profile, failure, retry } = useSession();
  const { state, reload } = useLoad(() => readPage("call", { spaceId }), `call:${spaceId}`);
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const owner = useMemo(() => ownerAccess(spaceId), [spaceId]);
  const [client, setClient] = useState<SpaceClient | null>(null);
  useEffect(() => {
    const owned = createSpaceClientForPlatform({ space: spaceId, getAccess: owner.getAccess, baseUrl: import.meta.env.VITE_API_URL?.trim() || undefined }, { syncUrl: import.meta.env.VITE_CHALK_SYNC_URL?.trim() || undefined });
    const pagehide = (event: PageTransitionEvent) => {
      if (!event.persisted) owner.saveReload(owned.getSnapshot());
    };
    window.addEventListener("pagehide", pagehide);
    setClient(owned);
    return () => {
      window.removeEventListener("pagehide", pagehide);
      void owned
        .leave()
        .catch(() => undefined)
        .finally(() => owned.dispose());
    };
  }, [spaceId, owner]);
  const leave = () => {
    owner.clearReload();
    void navigate({ to: "/dashboard/call/$spaceId", params: { spaceId } });
  };

  const error = failure ?? (state.kind === "error" ? state.error : null);
  if (error)
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <ErrorPanel title="Couldn’t open the call" detail={errorMessage(error)} onRetry={failure ? retry : reload} />
          </div>
        </div>
      </SiteRoot>
    );
  if (!profile || state.kind !== "ready" || !client)
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <p role="status">Opening your call…</p>
          </div>
        </div>
      </SiteRoot>
    );
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Chalk client={client} inviteLink={state.data.inviteUrl} spaceName={state.data.call.name} displayName={profile.name} theme={{ colorScheme: theme }} onColorSchemeChange={setTheme} onLeft={leave} onEpisodeEnded={leave} />
    </div>
  );
}
