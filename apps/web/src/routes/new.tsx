import { useConnection } from "@q9labs/chalk-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/new")({
  component: NewRoomPage,
});

function NewRoomPage() {
  const navigate = useNavigate();
  const { createSession } = useConnection();
  const startedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;

    void (async () => {
      try {
        const roomId = await createSession("Instant meeting");
        await navigate({
          to: "/room/$roomId",
          params: { roomId },
          search: { autoJoin: true },
          replace: true,
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create meeting",
        );
      }
    })();
  }, [createSession, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/80 p-8 text-center shadow-2xl backdrop-blur">
        {error ? (
          <>
            <h1 className="text-2xl font-semibold text-card-foreground">
              Couldn&apos;t start meeting
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <div className="mx-auto h-11 w-11 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <h1 className="mt-6 text-2xl font-semibold text-card-foreground">
              Starting your room
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Creating a fresh room and joining automatically.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
