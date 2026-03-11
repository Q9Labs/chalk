import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import z from "zod";
import { exchangeJoinToken, getApiUrl, setJoinContext } from "../../lib/internalAuth";

export const Route = createFileRoute("/j/$joinToken")({
  component: JoinLinkPage,
  params: z.object({
    joinToken: z.string(),
  }),
});

function JoinLinkPage() {
  const { joinToken } = Route.useParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const redirectPath = await resolveJoinLinkRedirect(joinToken);
        if (cancelled) return;
        window.location.replace(redirectPath);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [joinToken]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-3">
        <h1 className="text-xl font-semibold">Joining meeting</h1>
        <p className="text-sm text-muted-foreground">{error ? "Could not join." : "Preparing your session..."}</p>
        {error && <pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{error}</pre>}
      </div>
    </div>
  );
}

export async function resolveJoinLinkRedirect(joinToken: string): Promise<string> {
  const apiUrl = getApiUrl();
  const ex = await exchangeJoinToken(apiUrl, joinToken);
  setJoinContext({
    joinToken,
    roomName: ex.room_name,
    accessToken: ex.access_token,
    expiresAtMs: Date.now() + ex.expires_in * 1000,
  });
  return `/room/${encodeURIComponent(ex.room_name)}`;
}
