import * as Schema from "effect/Schema";

// Keep names short enough for every derived AWS role/function/schedule name.
const ephemeralName = Schema.String.pipe(Schema.check(Schema.isPattern(/^nightly-[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$/)), Schema.brand("EphemeralStageName"));
export const productionStageName = Schema.Literal("production");
export const stageName = Schema.Union([productionStageName, ephemeralName]);
export type Stage = { readonly kind: "production"; readonly name: "production" } | { readonly kind: "ephemeral"; readonly name: typeof ephemeralName.Type };
export function parseStage(value: unknown): Stage {
  if (value === "production") return { kind: "production", name: "production" };
  return { kind: "ephemeral", name: Schema.decodeUnknownSync(ephemeralName)(value) };
}
