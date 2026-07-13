import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const contractUrl = new URL("../../../../contract/webhooks/v1/event.schema.json", import.meta.url);
const fixturesUrl = new URL("../../../../contract/webhooks/v1/fixtures.json", import.meta.url);
const outputUrl = new URL("../src/webhooks/generated/event-v1.ts", import.meta.url);
const fixturesOutputUrl = new URL("../src/webhooks/generated/fixtures-v1.ts", import.meta.url);
const run = promisify(execFile);

const schema = JSON.parse(await readFile(contractUrl, "utf8"));
const fixtures = JSON.parse(await readFile(fixturesUrl, "utf8"));
const resolveDefinition = (entry) => {
  if (!entry.$ref) return entry;
  return resolveDefinition(schema.$defs[entry.$ref.split("/").at(-1)]);
};
const eventNames = schema.oneOf.map((entry) => resolveDefinition(entry).properties.event.const);

const source = `// Generated from contract/webhooks/v1/event.schema.json. Do not edit.
export const webhookEventSchemaV1 = ${JSON.stringify(schema, null, 2)} as const;

export const knownWebhookEventNamesV1 = ${JSON.stringify(eventNames, null, 2)} as const;
export type KnownWebhookEventNameV1 = (typeof knownWebhookEventNamesV1)[number];

type JsonObject = Readonly<Record<string, unknown>>;
type Defs = typeof webhookEventSchemaV1.$defs;
type RefName<Ref extends string> = Ref extends \`#/$defs/\${infer Name}\` ? Name : never;
type ResolveRef<Ref extends string> = RefName<Ref> extends keyof Defs ? SchemaType<Defs[RefName<Ref>]> : unknown;
type RequiredKeys<Schema> = Schema extends { readonly required: readonly (infer Key extends string)[] } ? Key : never;
type PropertiesType<Schema extends { readonly properties: Readonly<Record<string, unknown>> }> =
  { readonly [Key in keyof Schema["properties"] as Key extends RequiredKeys<Schema> ? Key : never]-?: SchemaType<Schema["properties"][Key]> } &
  { readonly [Key in keyof Schema["properties"] as Key extends RequiredKeys<Schema> ? never : Key]?: SchemaType<Schema["properties"][Key]> } & JsonObject;
type TypeName<Value> = Value extends "string" ? string : Value extends "number" | "integer" ? number : Value extends "boolean" ? boolean : Value extends "null" ? null : Value extends "array" ? readonly unknown[] : Value extends "object" ? JsonObject : unknown;
type TypeNames<Values> = Values extends readonly (infer Value)[] ? TypeName<Value> : TypeName<Values>;
type SchemaBase<Schema> =
  Schema extends { readonly $ref: infer Ref extends string } ? ResolveRef<Ref> :
  Schema extends { readonly const: infer Value } ? Value :
  Schema extends { readonly enum: readonly (infer Value)[] } ? Value :
  Schema extends { readonly properties: Readonly<Record<string, unknown>> } ? PropertiesType<Schema> :
  Schema extends { readonly type: "array"; readonly items: infer Item } ? readonly SchemaType<Item>[] :
  Schema extends { readonly type: infer Type } ? TypeNames<Type> : unknown;
type SchemaBranches<Schema> =
  Schema extends { readonly oneOf: readonly (infer Branch)[] } ? SchemaType<Branch> : unknown;
type SchemaAllOf<Schema> = Schema extends { readonly allOf: readonly [infer First, ...infer Rest] }
  ? SchemaType<First> & SchemaAllOf<{ readonly allOf: Rest }>
  : unknown;
export type SchemaType<Schema> = SchemaBase<Schema> & SchemaBranches<Schema> & SchemaAllOf<Schema>;

export type KnownWebhookEventV1 = SchemaType<typeof webhookEventSchemaV1>;
export type RoomWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: \`room.\${string}\` }>;
export type SessionWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: \`session.\${string}\` }>;
export type ParticipantWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: \`participant.\${string}\` }>;
export type RecordingWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: \`recording.\${string}\` }>;
export type TranscriptWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: \`transcript.\${string}\` }>;
export type EndpointTestWebhookEvent = Extract<KnownWebhookEventV1, { readonly event: "endpoint.test" }>;
`;

const fixtureSource = `// Generated from contract/webhooks/v1/fixtures.json. Do not edit.
export const webhookFixturesV1 = ${JSON.stringify(fixtures.fixtures, null, 2)} as const;
`;

if (process.argv.includes("--check")) {
  const directory = await mkdtemp(join(tmpdir(), "chalk-webhooks-contract-"));
  const temporaryOutput = join(directory, "event-v1.ts");
  const temporaryFixtures = join(directory, "fixtures-v1.ts");
  try {
    await Promise.all([writeFile(temporaryOutput, source), writeFile(temporaryFixtures, fixtureSource)]);
    await run("pnpm", ["exec", "oxfmt", temporaryOutput, temporaryFixtures]);
    const [currentSource, currentFixtures, generatedSource, generatedFixtures] = await Promise.all([readFile(outputUrl, "utf8"), readFile(fixturesOutputUrl, "utf8"), readFile(temporaryOutput, "utf8"), readFile(temporaryFixtures, "utf8")]);
    if (generatedSource !== currentSource || generatedFixtures !== currentFixtures) {
      throw new Error("Generated webhook receiver contract is stale. Run pnpm run generate:webhooks.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} else {
  await Promise.all([writeFile(outputUrl, source), writeFile(fixturesOutputUrl, fixtureSource)]);
  await run("pnpm", ["exec", "oxfmt", fileURLToPath(outputUrl), fileURLToPath(fixturesOutputUrl)]);
}
