import type { GetAccess, SpaceClient } from "@q9labsai/chalk-client";
import { expectTypeOf, test } from "vitest";

import type { NativeSpaceClientOptions } from "./client";

test("the native client subpath exposes the advanced-construction contract", () => {
  expectTypeOf<NativeSpaceClientOptions>().toMatchTypeOf<{
    readonly space: string;
    readonly getAccess: GetAccess;
  }>();
  expectTypeOf<typeof import("./client").createNativeSpaceClient>().returns.toEqualTypeOf<SpaceClient>();
});
