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
      // Without a newer action, Sync turned it off while the device was gone: the recovered item says so with a stop newer than the old action.
      // With one, the user's Off is the owed command, and an empty projection is no evidence either way.
      const recovered = newerAction ? [] : [{ ...publication, enabled: false, publicationId: null, offReason: "host" as const, offRevision: 9 }];
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "recovered", sequence: 0, items: recovered } });
      platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      if (newerAction) {
        await vi.waitFor(() => expect(command).toHaveBeenLastCalledWith(false));
        // Only the explicit Off closes it; recovery must not close it again.
        expect(close).toHaveBeenCalledExactlyOnceWith(source, "user_pause");
      } else {
        await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(source, "moderation_pause"));
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
