import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import * as v from "valibot";
import { getApiUrl } from "../../lib/appApi";

const shareParamsSchema = v.object({
  token: v.string(),
});

export const Route = createFileRoute("/share/$token")({
  component: SharePage,
  params: {
    parse: (params) => v.parse(shareParamsSchema, params),
  },
});

type ShareResponse = {
  recording: {
    id: string;
    room_id: string;
    room_name: string;
    status: string;
    started_at?: unknown;
    ended_at?: unknown;
    duration?: number | null;
    size_bytes?: number | null;
    download_url?: string | null;
    metadata?: unknown;
  };
  transcript?: {
    text?: string | null;
    status?: string | null;
  } | null;
};

function SharePage() {
  const { token } = Route.useParams();
  const [data, setData] = useState<ShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const apiUrl = getApiUrl();
        const res = await fetch(`${apiUrl}/api/v1/public/share/${token}`);
        if (!res.ok) throw new Error("Not found");
        const json = (await res.json()) as ShareResponse;
        if (cancelled) return;
        setData(json);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-3">
          <h1 className="text-xl font-semibold">Recording not found</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-3">
          <h1 className="text-xl font-semibold">Loading</h1>
          <p className="text-sm text-muted-foreground">Fetching recording...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{data.recording.room_name || "Recording"}</h1>
          <p className="text-sm text-muted-foreground">Status: {data.recording.status}</p>
        </div>

        {data.recording.download_url ? (
          <a href={data.recording.download_url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm font-medium">
            Download recording
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">Download not available.</p>
        )}

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Transcript</h2>
          {data.transcript?.text ? <pre className="rounded-lg bg-muted p-4 text-sm whitespace-pre-wrap">{data.transcript.text}</pre> : <p className="text-sm text-muted-foreground">{data.transcript?.status === "processing" ? "Transcription processing..." : "No transcript available."}</p>}
        </div>
      </div>
    </div>
  );
}
