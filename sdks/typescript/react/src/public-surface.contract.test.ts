import { describe, expect, it } from "vitest";

import "./public-surface.contract";
import * as sdk from "./index";

const expectedHooks = ["useSpaceClient", "useConnection", "useSelf", "useParticipants", "useMedia", "useChat", "useReactions", "useWhiteboard", "useCan"] as const;

describe("React SDK public surface contract", () => {
  it("keeps the runtime package shape aligned with the compile-time contract", () => {
    const runtimeHooks = Object.keys(sdk)
      .filter((exportName) => exportName.startsWith("use"))
      .sort();

    expect(runtimeHooks).toEqual([...expectedHooks].sort());
    expect(sdk.Chalk).toBeTypeOf("function");
    expect(sdk.ChalkProvider).toBeTypeOf("function");
    expect(sdk.Entrance).toBeTypeOf("function");
    expect(sdk.COSMIC_CHALK_THEME).toMatchObject({ skin: "chalk", palette: "cosmic-chalk", texture: "slate" });
  });
});
