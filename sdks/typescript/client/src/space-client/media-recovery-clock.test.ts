import { describe, expect, it } from "vitest";
import { confirmPublication, dropAndRecover, sources, type Source } from "../../tests/helpers/media-recovery";

type Outcome = "resumes" | "off";

async function expectOutcome(source: Source, outcome: Outcome, options: Parameters<typeof dropAndRecover>[1]) {
  const { client, platform, track, setLocalSourceIntent, finish } = await dropAndRecover(source, options);
  try {
    if (outcome === "resumes") {
      expect(track.enabled).toBe(true);
      confirmPublication(platform, track, source);
      expect(client.getSnapshot().media.local[source].state).toBe("enabled");
      expect(setLocalSourceIntent).not.toHaveBeenCalledWith(source, false, expect.anything());
    } else {
      expect(track.enabled).toBe(false);
      expect(client.getSnapshot().media.local[source].state).toBe("disabled");
      expect(setLocalSourceIntent).toHaveBeenCalledWith(source, false, "user_pause");
    }
  } finally {
    finish();
  }
}

// Only a drop proven short resumes without a tap. Each case here moves the clocks or the page the way a real device does.
describe("recovery resumes without a tap only after a drop proven short", () => {
  describe("a hidden tab is not evidence of a long drop", () => {
    // The teacher shares a screen from another tab, so the Chalk tab is hidden for the whole class and Chrome throttles its timers.
    it.each(sources)("%s: hidden tab, timers ticking at 1 s, a 3 s drop resumes", async (source) => {
      await expectOutcome(source, "resumes", {
        beforeLoss: (rig) => {
          rig.page.visibilityState = "hidden";
          rig.heartbeats(60_000);
        },
        drop: (rig) => {
          for (let second = 0; second < 3; second += 1) rig.elapse(1_000);
        },
      });
    });

    it.each(sources)("%s: hidden tab, timers stretched to 60 s by intensive throttling, a 3 s drop resumes", async (source) => {
      await expectOutcome(source, "resumes", {
        beforeLoss: (rig) => {
          rig.page.visibilityState = "hidden";
          rig.heartbeats(180_000);
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });

    it.each(sources)("%s: hidden tab plus a freeze event during the drop stays off", async (source) => {
      await expectOutcome(source, "off", {
        beforeLoss: (rig) => {
          rig.page.visibilityState = "hidden";
          rig.heartbeats(60_000);
        },
        drop: (rig) => {
          rig.elapse(3_000);
          rig.page.dispatch("freeze");
        },
      });
    });
  });

  describe("a hidden tab with intensively throttled timers", () => {
    // Chrome runs timers once a minute in a page that has been hidden for 5 minutes and holds no live WebRTC connection, so both
    // ping loops send once a minute and the replies arrive 60 s apart. Every reply follows its predecessor by 60 s, which the link
    // watch treats as a gap, so the proof never refreshes and a 3 s drop reads long. The source turns off and one tap turns it on.
    // Known gap, kept failing on purpose (Vitest reports it once it passes). A gap threshold of 60 s or more would also let a
    // 45 s suspend plus a 30 s drop resume, which is the fail-open case the rule exists to stop, and a page cannot tell a
    // suspend from throttling when both clocks keep running. Chrome exempts a page with a live WebRTC connection from this throttling.
    it.fails.each(sources)("%s: known gap: replies 60 s apart and a 3 s drop is judged long", async (source) => {
      await expectOutcome(source, "resumes", {
        beforeLoss: (rig) => {
          rig.page.visibilityState = "hidden";
          rig.heartbeats(180_000, 60_000);
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });
  });

  describe("the clocks", () => {
    it.each(sources)("%s: a continuous short drop resumes", async (source) => {
      await expectOutcome(source, "resumes", { beforeLoss: (rig) => rig.heartbeats(100_000), drop: (rig) => rig.elapse(3_000) });
    });

    it.each(sources)("%s: the wall clock stepping back during the drop stays off", async (source) => {
      await expectOutcome(source, "off", { drop: (rig) => rig.advance({ wall: -10_000, mono: 3_000 }) });
    });

    it.each(sources)("%s: the wall clock stepping forward 60 s during a 3 s drop stays off", async (source) => {
      await expectOutcome(source, "off", { drop: (rig) => rig.advance({ wall: 63_000, mono: 3_000 }) });
    });

    // A step back hides the wall time, but the monotonic clock still shows 60 s.
    it.each(sources)("%s: the monotonic clock at 60 s with a wall clock stepped back stays off", async (source) => {
      await expectOutcome(source, "off", { drop: (rig) => rig.advance({ wall: 1_000, mono: 60_000 }) });
    });

    it.each(sources)("%s: a suspend that stops the monotonic clock still reads long on the wall clock", async (source) => {
      await expectOutcome(source, "off", { drop: (rig) => rig.advance({ wall: 120_000, mono: 0 }) });
    });
  });

  describe("frames that arrive after a suspend", () => {
    // The laptop sleeps, wakes, processes the frames buffered meanwhile, and only then notices the loss.
    it.each(sources)("%s: buffered frames processed after wake and before the loss do not make the drop look short", async (source) => {
      await expectOutcome(source, "off", {
        beforeLoss: (rig) => {
          rig.advance({ wall: 300_000, mono: 0 });
          rig.heard();
          rig.heard();
          rig.heard();
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });

    it.each(sources)("%s: a 45 s suspend and the buffered frames after it do not hide a 30 s drop", async (source) => {
      await expectOutcome(source, "off", {
        beforeLoss: (rig) => {
          rig.elapse(45_000);
          rig.heard();
          rig.heard();
        },
        drop: (rig) => rig.elapse(30_000),
      });
    });

    it.each(sources)("%s: after a suspend and 20 s of steady heartbeats, a 3 s drop resumes", async (source) => {
      await expectOutcome(source, "resumes", {
        beforeLoss: (rig) => {
          rig.advance({ wall: 300_000, mono: 0 });
          rig.heard();
          rig.heartbeats(60_000);
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });
  });

  describe("page lifecycle", () => {
    it.each(sources)("%s: a freeze before the loss, with buffered frames after it, stays off", async (source) => {
      await expectOutcome(source, "off", {
        beforeLoss: (rig) => {
          rig.elapse(10_000);
          rig.page.dispatch("freeze");
          rig.elapse(10_000);
          rig.page.dispatch("resume");
          rig.heard();
          rig.heard();
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });

    it.each(sources)("%s: a resume event after the drop began stays off", async (source) => {
      await expectOutcome(source, "off", {
        drop: (rig) => {
          rig.elapse(3_000);
          rig.page.dispatch("resume");
        },
      });
    });

    it.each(sources)("%s: a discarded page stays off", async (source) => {
      await expectOutcome(source, "off", {
        drop: (rig) => {
          rig.elapse(3_000);
          rig.page.wasDiscarded = true;
        },
      });
    });

    it.each(sources)("%s: a freeze and resume that left no drop do not turn off a later short drop", async (source) => {
      await expectOutcome(source, "resumes", {
        beforeLoss: (rig) => {
          rig.page.dispatch("freeze");
          rig.page.dispatch("resume");
          rig.heard();
          rig.heartbeats(60_000);
        },
        drop: (rig) => rig.elapse(3_000),
      });
    });
  });
});
