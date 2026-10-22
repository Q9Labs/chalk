// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { Chalk } from "./Chalk";

it.each(["unmute", "start_camera"] as const)("checks the current connection before allowing web %s requests", async (kind) => {
  const base = createSnapshot(["publishAudio", "publishVideo"]);
  const snapshot = { ...base, connection: { ...base.connection, status: "live" as const }, media: { ...base.media, incomingRequests: [{ requestId: "request", kind, actorParticipantId: "host", actorDisplayName: "Host", expiresAt: new Date(Date.now() + 60_000).toISOString() }] } };
  const client = createPreviewClient(snapshot);
  const accept = vi.spyOn(client.media, "acceptRequest");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chalk client={client} features={{ sounds: false, whiteboard: false }} />));
    const action = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Allow");
    if (!action) throw new Error("Missing web request acceptance");
    const current = vi.spyOn(client, "getSnapshot").mockReturnValue({ ...snapshot, connection: { ...snapshot.connection, status: "reconnecting", syncHealth: "recovering" } });
    await act(async () => action.click());
    expect(accept).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label$="request"]')).not.toBeNull();
    current.mockReturnValue({ ...snapshot, connection: { ...snapshot.connection, syncHealth: "degraded" } });
    await act(async () => action.click());
    expect(accept).toHaveBeenCalledWith("request");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
  }
});
