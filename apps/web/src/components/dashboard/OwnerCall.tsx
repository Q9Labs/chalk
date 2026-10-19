import type { GetAccess } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import type { OwnerAccessDTO } from "../../lib/dashboard/contracts";
import { act, errorMessage, intentKey } from "../../lib/dashboard/client";
import { SiteRoot, useSiteTheme } from "../site/theme";
import { useSession } from "./AppShell";
import { ErrorPanel } from "./kit";

/**
 * The current media token inside a grant, so a scheduled refresh keeps the media connection.
 * The grant is opaque to the SDK's callers; the call app reads it the same way in chalk-access.
 */
function mediaToken(access: OwnerAccessDTO["access"]): string | undefined {
  const value: unknown = access;
  if (typeof value !== "object" || value === null || !("media" in value) || typeof value.media !== "object" || value.media === null || !("token" in value.media)) return undefined;
  return typeof value.media.token === "string" && value.media.token ? value.media.token : undefined;
}

/** Owner access for one call: `join` admits the owner, `refresh-access` renews the same seat. */
function ownerAccess(spaceId: string): GetAccess {
  const joinKey = intentKey();
  let current: string | undefined;
  return async ({ reason, replaceMediaConnection }) => {
    const { access } =
      reason === "join"
        ? await act("call", { action: "join", spaceId, idempotencyKey: joinKey })
        : // Without the current token the server replaces the media connection.
          await act("call", { action: "refresh-access", spaceId, ...(!replaceMediaConnection && current ? { currentMediaToken: current } : {}) });
    current = mediaToken(access);
    return access;
  };
}

/** The call screen for the call's owner, through the React SDK's own call UI. */
export function OwnerCall({ spaceId }: { readonly spaceId: string }) {
  const { profile, failure, retry } = useSession();
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const getAccess = useMemo(() => ownerAccess(spaceId), [spaceId]);
  const leave = () => void navigate({ to: "/dashboard/call/$spaceId", params: { spaceId } });

  if (failure)
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <ErrorPanel title="Couldn’t open the call" detail={errorMessage(failure)} onRetry={retry} />
          </div>
        </div>
      </SiteRoot>
    );
  if (!profile) return null;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Chalk space={spaceId} getAccess={getAccess} displayName={profile.name} theme={{ colorScheme: theme }} onColorSchemeChange={setTheme} onLeft={leave} onEpisodeEnded={leave} />
    </div>
  );
}
