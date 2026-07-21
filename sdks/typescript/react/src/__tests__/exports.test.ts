import { describe, expect, it } from "vitest";

import * as atomic from "../components/atomic";
import * as composite from "../components/composite";
import * as full from "../components/full";
import * as sdk from "../index";

describe("React SDK public UI exports", () => {
  it("keeps atomic, composite, and full UI entry points importable", () => {
    expect(atomic.Avatar).toBeDefined();
    expect(composite.ReactionPicker).toBeDefined();
    expect(full.LoadingScreen).toBeDefined();
    expect(full.PreJoinLobby).toBeDefined();
    expect(full.SessionMeetingRoom).toBeDefined();
  });

  it("exports the UI layers and managed-session React bindings from the package root", () => {
    expect(sdk.atomic).toBeDefined();
    expect(sdk.composite).toBeDefined();
    expect(sdk.full).toBeDefined();
    expect(sdk.ChalkProvider).toBeDefined();
    expect(sdk.useChalkSession).toBeDefined();
  });
});
