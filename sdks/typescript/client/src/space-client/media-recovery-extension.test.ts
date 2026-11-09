import { describe, expect, it, vi } from "vitest";
import { enterRecovery } from "../../tests/helpers/media-convergence";
import { confirmPublication, dropAndRecover, hostStop, live, recoveryScenario, sources, tick, type Source } from "../../tests/helpers/media-recovery";

// The bounded rule needs the `off_reason` keys, which only a Sync that advertised `media_off_reason` in its welcome sends.
// Without it the SDK keeps the rule it had before: pause a wanted-on source when Sync's own item is missing or not enabled.
describe("the recovery rule follows what the connected Sync advertised", () => {
  const cases = sources.flatMap((source) =>
    [true, false].flatMap((extension) =>
      [true, false].map((replay) => ({
        source,
        extension,
        replay,
        // Only the new rule on a Sync that advertised it resumes, and only when the replay of the stop is lost.
        paused: !extension || replay,
      })),
    ),
  );

  it.each(cases)("$source: extension $extension, stop replay delivered $replay, no own item after a short drop pauses: $paused", async ({ source, extension, replay, paused }) => {
    const { client, platform, track, setLocalSourceIntent, finish } = await dropAndRecover(source, {
      extension,
      drop: (rig) => rig.elapse(3_000),
      beforeRecovered: replay ? (platform) => platform.emitMediaPause({ source, revision: 9 }) : undefined,
    });
    try {
      expect(track.enabled).toBe(!paused);
      if (paused) expect(client.getSnapshot().media.local[source].state).toBe("disabled");
      else {
        confirmPublication(platform, track, source);
        expect(client.getSnapshot().media.local[source].state).toBe("enabled");
      }
      expect(setLocalSourceIntent.mock.calls.some(([, enabled]) => enabled === false)).toBe(paused);
    } finally {
      finish();
    }
  });

  it.each(sources)("%s: without the extension a tombstone item pauses the source with the cause master used", async (source) => {
    const item = { participantId: "participant-1", source, enabled: false, publicationId: null };
    const { track, setLocalSourceIntent, finish } = await dropAndRecover(source, { extension: false, items: [item] });
    try {
      expect(track.enabled).toBe(false);
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "sync_recovery_loss");
    } finally {
      finish();
    }
  });

  it.each(sources)("%s: without the extension a lost publication pauses it after a drop of 1 s", async (source) => {
    const { track, setLocalSourceIntent, finish } = await dropAndRecover(source, { extension: false });
    try {
      expect(track.enabled).toBe(false);
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "sync_recovery_loss");
    } finally {
      finish();
    }
  });

  it.each(sources)("%s: without the extension a listed publication keeps the source on", async (source) => {
    const item = { participantId: "participant-1", source, enabled: true, publicationId: "publication-1" };
    const { track, setLocalSourceIntent, finish } = await dropAndRecover(source, { extension: false, items: [item] });
    try {
      expect(track.enabled).toBe(true);
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
    } finally {
      finish();
    }
  });

  it.each(sources)("%s: a Sync client that reports nothing about the extension gets the old rule", async (source) => {
    const { client, platform, track, setEnabled, setLocalSourceIntent } = recoveryScenario(source, { sync: { offReasonNegotiated: undefined } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "sync_recovery_loss");
    } finally {
      client.dispose();
    }
  });

  // The next connection can reach a different Sync (a rolling deploy), so each recovery asks again.
  it.each(sources)("%s: the answer is read for each connection", async (source) => {
    const { client, platform, track, rig, setLocalSourceIntent, finish } = await dropAndRecover(source);
    try {
      expect(track.enabled).toBe(true);
      rig.extension = false;
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered-2", sequence: 1, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "sync_recovery_loss");
    } finally {
      finish();
    }
  });

  it.each(sources)("%s: a client that does not report the clock gets no resume after a long-looking drop", async (source) => {
    const { client, platform, track, setEnabled } = recoveryScenario(source, { sync: { link: undefined, offReasonNegotiated: () => true } });
    try {
      await client.join({ microphone: false, camera: false });
      await setEnabled(true);
      await enterRecovery({ platform, client });
      platform.emitSync({ ...live(platform), media: { projectionId: "recovered", sequence: 0, items: [] } });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(track.enabled).toBe(false));
    } finally {
      client.dispose();
    }
  });
});

// Recovery captures the sources that are wanted on when it begins. A source the user turns on after that is not in the capture,
// and the host's stop in the snapshot still applies to it.
describe("a source enabled after recovery began", () => {
  // The first Sync snapshot of a join is the first recovery, and a source the user turns on while the join waits for Sync is not
  // in its capture either.
  it.each(sources)("%s: a host stop in the first snapshot keeps an enable queued during the join off", async (source) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder: { start?: () => Promise<void> } = {};
    const { client, platform, setEnabled, setLocalSourceIntent } = recoveryScenario(source, { sync: { start: async () => (await gate, holder.start?.()) } });
    holder.start = () => platform.sync.start();
    try {
      platform.emitSync({ ...platform.sync.getSnapshot(), media: { projectionId: "rejoined", sequence: 0, items: [hostStop(source, 900)] } });
      const joining = client.join({ microphone: false, camera: false });
      await tick(20);
      const enabling = setEnabled(true);
      await tick(20);
      release();
      await joining;
      await enabling.catch(() => undefined);
      await tick(20);
      expect(client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, true, expect.anything());
    } finally {
      client.dispose();
    }
  });
});

// Intent revisions are per device, but a stop's revision and an intent's control revision are positions in the one control stream
// of the Episode, so every device of one participant compares the same numbers.
describe("two devices of one participant", () => {
  // Device B hears the host stop at 90 and turns the source on again. Sync accepts that and keeps the stop (it is still the
  // latest host stop), because device A is offline with an older on and must learn of the stop when it recovers.
  it.each(sources)("%s: the offline device with the older on does not resume, the device that heard the stop keeps its on", async (source) => {
    const a = recoveryScenario(source);
    const b = recoveryScenario(source);
    try {
      await a.client.join({ microphone: false, camera: false });
      await a.setEnabled(true);
      await b.client.join({ microphone: false, camera: false });
      await b.setEnabled(true);
      b.platform.emitMediaPause({ source, revision: 90 });
      await vi.waitFor(() => expect(b.track.enabled).toBe(false));
      await b.setEnabled(true);
      b.setLocalSourceIntent.mockClear();
      await enterRecovery({ platform: a.platform, client: a.client });
      await enterRecovery({ platform: b.platform, client: b.client });
      // B's publication is not listed yet; A's replay of the stop is lost.
      const recovered = (stop: Source) => ({ projectionId: "recovered", sequence: 0, items: [hostStop(stop, 90)] });
      a.platform.emitSync({ ...live(a.platform), media: recovered(source) });
      b.platform.emitSync({ ...live(b.platform), media: recovered(source) });
      await vi.waitFor(() => expect(a.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(b.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(a.track.enabled).toBe(false));
      await tick(20);
      expect(a.client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(a.setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause");
      expect(b.setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
    } finally {
      a.client.dispose();
      b.client.dispose();
    }
  });

  it.each(sources)("%s: the offline device with the older on does not resume when the other device has published again, and that device keeps its on", async (source) => {
    const a = recoveryScenario(source);
    const b = recoveryScenario(source);
    try {
      await a.client.join({ microphone: false, camera: false });
      await a.setEnabled(true);
      await b.client.join({ microphone: false, camera: false });
      await b.setEnabled(true);
      b.platform.emitMediaPause({ source, revision: 90 });
      await vi.waitFor(() => expect(b.track.enabled).toBe(false));
      await b.setEnabled(true);
      b.setLocalSourceIntent.mockClear();
      await enterRecovery({ platform: a.platform, client: a.client });
      await enterRecovery({ platform: b.platform, client: b.client });
      // B has published again, so the item is enabled and still carries the stop; A's replay of the stop is lost.
      const recovered = (stop: Source) => ({ projectionId: "recovered", sequence: 0, items: [{ ...hostStop(stop, 90), enabled: true, publicationId: "publication-b" }] });
      a.platform.emitSync({ ...live(a.platform), media: recovered(source) });
      b.platform.emitSync({ ...live(b.platform), media: recovered(source) });
      await vi.waitFor(() => expect(a.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(b.client.getSnapshot().connection.status).toBe("live"));
      await vi.waitFor(() => expect(a.track.enabled).toBe(false));
      await tick(20);
      expect(a.client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(a.setLocalSourceIntent).toHaveBeenCalledWith(source, false, "moderation_pause");
      expect(b.setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
    } finally {
      a.client.dispose();
      b.client.dispose();
    }
  });
});
