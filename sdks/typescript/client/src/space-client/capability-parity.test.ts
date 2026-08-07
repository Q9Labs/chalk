import { readFileSync } from "node:fs";
import { expect, expectTypeOf, it } from "vitest";
import { CapabilitySchema } from "../generated/sync";
import type { ConnectionCapability } from "../connection/types";
import { CAPABILITIES } from "./participants-controller";
import type { Capability } from "./types";
import { V1_CAPABILITIES, type V1Capability } from "../sync/v1-types";

type CapabilitySchemaAst = {
  readonly _tag: "Union";
  readonly types: readonly { readonly _tag: "Literal"; readonly literal: string }[];
};

const schemaCapabilities = (CapabilitySchema.ast as CapabilitySchemaAst).types.map(({ literal }) => literal);
const goServiceSource = readFileSync(new URL("../../../../../apps/api/internal/spaces/service.go", import.meta.url), "utf8");

function goCapabilities(source: string): string[] {
  const declaration = source.match(/var allCapabilities = \[\]string\{([\s\S]*?)\}/u);
  if (!declaration) throw new Error("Could not find allCapabilities in apps/api/internal/spaces/service.go");
  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map(([, capability]) => capability!);
}

it("keeps every client capability declaration in parity", () => {
  expectTypeOf<Capability>().toEqualTypeOf<V1Capability>();
  expectTypeOf<ConnectionCapability>().toEqualTypeOf<V1Capability>();
  expect([...CAPABILITIES].sort()).toEqual([...V1_CAPABILITIES].sort());
  expect(schemaCapabilities.sort()).toEqual([...V1_CAPABILITIES].sort());
  expect(goCapabilities(goServiceSource).sort()).toEqual([...V1_CAPABILITIES].sort());
});
