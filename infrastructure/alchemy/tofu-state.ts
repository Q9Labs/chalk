import * as Provider from "alchemy/Provider";
import type { ResourceClassLike, ResourceLike } from "alchemy/Resource";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const tofuState = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(4),
    resources: Schema.Array(
      Schema.Struct({
        mode: Schema.Literals(["data", "managed"]),
        type: Schema.String,
        name: Schema.String,
        module: Schema.optional(Schema.String),
        instances: Schema.Array(Schema.Struct({ attributes: Schema.Unknown, deposed: Schema.optional(Schema.String) })),
      }),
    ),
  }),
);

export const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, label: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new Error(`Invalid ${label}; state contents are not printed.`);
  }
};

export const lookup = <R extends ResourceLike>(resource: ResourceClassLike<R>, props: R["Lookup"]) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(resource);
    if (!provider.lookup) return yield* Effect.die(`No lookup for ${resource.Type}`);
    const attributes = yield* provider.lookup(props);
    if (!attributes) return yield* Effect.die(`Existing ${resource.Type} was not found; refusing to seed.`);
    return attributes;
  });

export const row = <P extends object, A extends object>(resourceType: string, logicalId: string, instanceId: string, props: P, attr: A, downstream: string[], removalPolicy: "retain" | "destroy" | "protect" = "destroy"): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  instanceId,
  namespace: undefined,
  providerVersion: 0,
  props: { ...props },
  attr: { ...attr },
  bindings: [],
  downstream,
  removalPolicy,
});

export type TofuState = Schema.Schema.Type<typeof tofuState>;
export const resourceAddress = (resource: TofuState["resources"][number]): string => `${resource.module ? `${resource.module}.` : ""}${resource.mode === "data" ? "data." : ""}${resource.type}.${resource.name}`;
export const expectResources = (source: TofuState, addresses: string[]) => {
  const managed = source.resources.filter((resource) => resource.mode === "managed");
  if (managed.length !== addresses.length || new Set(managed.map(resourceAddress)).size !== addresses.length || managed.some((resource) => !addresses.includes(resourceAddress(resource)))) throw new Error("Unexpected managed resources; refusing partial migration.");
};
export const getResource = <A>(source: TofuState, address: string, schema: Schema.Codec<A>): A => {
  const matches = source.resources.filter((resource) => resourceAddress(resource) === address);
  const resource = matches[0];
  const instance = resource?.instances[0];
  if (matches.length !== 1 || resource?.instances.length !== 1 || !instance || instance.deposed) throw new Error(`Expected exactly one current ${address}; refusing to seed.`);
  return decode(schema, instance.attributes, `${address} attributes`);
};

export const observe = <R extends ResourceLike>(resource: ResourceClassLike<R>, props: R["Props"], logicalId: string) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(resource);
    if (!provider.read) return yield* Effect.die(`No reader for ${resource.Type}`);
    const attr = yield* provider.read({ id: logicalId, fqn: logicalId, instanceId: logicalId, olds: props, output: undefined });
    if (!attr) return yield* Effect.die(`Existing ${resource.Type} was not found; refusing to seed.`);
    return { ...attr };
  });

export { canonicalSetJson as semanticJson } from "./bucket-policy.ts";
