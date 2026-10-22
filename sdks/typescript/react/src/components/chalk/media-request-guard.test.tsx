// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { liveMediaClient } from "../../../tests/helpers/live-media";
import { Chalk } from "./Chalk";

it.each(["unmute", "start_camera"] as const)("checks the current connection before allowing web %s requests", async (kind) => {
  const fixture = await liveMediaClient();
  const { client, capture } = fixture;
  fixture.request(kind);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chalk client={client} features={{ sounds: false, whiteboard: false }} />));
    const action = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Allow");
    if (!action) throw new Error("Missing web request acceptance");
    await act(async () => fixture.health(true));
    await act(async () => action.click());
    await expect(fixture.actions.request.mock.results.at(-1)?.value).rejects.toMatchObject({ code: "connection.invalid_state" });
    expect(capture).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label$="request"]')).not.toBeNull();
    await act(async () => fixture.health(false));
    await act(async () => action.click());
    await act(async () =>
      vi.waitFor(() => {
        expect(capture).toHaveBeenCalledOnce();
        expect(client.getSnapshot().media.incomingRequests).toHaveLength(0);
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
    vi.restoreAllMocks();
  }
});
