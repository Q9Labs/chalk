import { describe, expect, it, vi } from "vitest";
import { createConvergenceScenario, enterRecovery } from "../../tests/helpers/media-convergence";

const sources = ["microphone", "camera", "screen"] as const;
describe("recovery publication authority", () => {
  it.each(sources.flatMap((source) => [false, true].map((newerAction) => ({ source, newerAction }))))("scopes a recovered lost $source publication to its old action (newer: $newerAction)", async ({ source, newerAction }) => {
    const close = vi.fn(async () => undefined);
    const { platform, client, track, setEnabled, command } = createConvergenceScenario(source, { media: { closeForcedLocalPublication: close } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      const publication = { participantId: "participant-1", source, enabled: true, publicationId: "old-publication" };
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "old", sequence: 4, items: [publication] } });
      platform.emitSync({ ...platform.sync.getSnapshot(), media: null, connection: { phase: "recovering" } });
      await enterRecovery({ platform, client });
      // A later local action must not be treated as the generation whose publication was lost.
      if (newerAction) await setEnabled(false);
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "recovered", sequence: 0, items: [] } });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      if (newerAction) {
        await vi.waitFor(() => expect(command).toHaveBeenLastCalledWith(false));
        // Only the explicit Off closes it; recovery must not close it again.
        expect(close).toHaveBeenCalledExactlyOnceWith(source);
      } else {
        await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(source));
        expect(track.enabled).toBe(false);
        expect(command).toHaveBeenCalledExactlyOnceWith(true);
        // A fresh On remains available; recovery never writes the user's desired intent.
        await setEnabled(true);
        expect(command.mock.calls.map(([enabled]) => enabled)).toEqual([true, true]);
      }
    } finally {
      client.dispose();
    }
  });
});
