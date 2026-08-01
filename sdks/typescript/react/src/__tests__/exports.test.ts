import { describe, expect, it } from "vitest";

import * as components from "../components";
import * as sdk from "../index";

describe("React SDK public UI exports", () => {
  it("exports the canonical UI catalog through components", () => {
    expect(components.Avatar).toBeDefined();
    expect(components.ReactionPicker).toBeDefined();
    expect(components.JoiningScreen).toBeDefined();
    expect(components.PreJoinScreen).toBeDefined();
    expect(components.ConferenceView).toBeDefined();
  });

  it("exports the UI catalog and managed-session React bindings from the package root", () => {
    expect(sdk.ConferenceView).toBeDefined();
    expect(sdk.ParticipantGrid).toBeDefined();
    expect(sdk.ChalkProvider).toBeDefined();
    expect(sdk.useChalkSession).toBeDefined();
  });

  it("does not expose the retired component category namespaces", () => {
    expect("atomic" in sdk).toBe(false);
    expect("composite" in sdk).toBe(false);
    expect("full" in sdk).toBe(false);
  });
});
