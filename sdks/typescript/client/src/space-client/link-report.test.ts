import { describe, expect, it, vi } from "vitest";
import type { CallStatsSample } from "../media/call-stats";
import { createConvergenceScenario, enterRecovery } from "../../tests/helpers/media-convergence";

const window = (): CallStatsSample => ({ elapsed_ms: 10_000, window_ms: 10_000, connection_type: "udp", recv_loss_pct: 20 });

describe("sharing the link tier with Sync", () => {
  it("tells the next live socket the tier again, because Sync forgets a rating with its socket", async () => {
    const setConnectionQuality = vi.fn();
    const scenario = createConvergenceScenario("microphone", { sync: { setConnectionQuality } });
    try {
      await scenario.client.join({ microphone: false, camera: false });
      const first = window();
      scenario.platform.media.emit({ ...scenario.platform.media.getSnapshot(), callStats: [first] });
      scenario.platform.media.emit({ ...scenario.platform.media.getSnapshot(), callStats: [first, window()] });
      await vi.waitFor(() => expect(setConnectionQuality).toHaveBeenCalledWith("poor"));
      expect(setConnectionQuality).toHaveBeenCalledTimes(1);

      await enterRecovery(scenario);
      scenario.platform.emitSync({ ...scenario.platform.sync.getSnapshot(), connection: { phase: "live" } });
      await vi.waitFor(() => expect(setConnectionQuality).toHaveBeenCalledTimes(2));
      expect(setConnectionQuality).toHaveBeenLastCalledWith("poor");
    } finally {
      scenario.client.dispose();
    }
  });
});
