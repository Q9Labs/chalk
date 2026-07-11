// @ts-check

import { describe, expect, it } from "vitest";
import { canonicalContractJson, canonicalizeContract } from "../src/contract-ir.mjs";
import { fixturePaths } from "../src/fixture-paths.mjs";
import { canonicalJsonFixture } from "../src/json-frontend.mjs";
import { canonicalFrontendOutputs } from "../src/proof.mjs";
import { compileTypeSpecFixture, loadTypeSpecContract } from "../src/typespec-frontend.mjs";

/** @typedef {Record<string, any>} ContractObject */

/** @template T @param {T | undefined} value @returns {T} */
function required(value) {
  if (value === undefined) {
    throw new Error("Expected fixture value");
  }
  return value;
}

async function validContract() {
  return JSON.parse(await canonicalJsonFixture(fixturePaths.json));
}

describe("ContractIR frontends", () => {
  it("produces byte-identical canonical IR from native JSON and TypeSpec semantic objects", async () => {
    const outputs = await canonicalFrontendOutputs();
    expect(outputs.typeSpecOutput).toBe(outputs.jsonOutput);
  });

  it("preserves error fields, response statuses, parameter requiredness, and sync protocol version", async () => {
    const contract = canonicalizeContract(await loadTypeSpecContract(fixturePaths.typeSpec));
    const declarations = /** @type {ContractObject[]} */ (contract.declarations);
    const validationError = declarations.find((declaration) => declaration.id === "chalk.ValidationError");
    const fields = /** @type {ContractObject[]} */ (validationError?.fields);
    const group = required(/** @type {ContractObject[]} */ (/** @type {ContractObject} */ (contract.http).groups)[0]);
    const operations = /** @type {ContractObject[]} */ (group.operations);
    const getTenant = required(operations.find((operation) => operation.id === "tenants.get"));
    const query = /** @type {ContractObject[]} */ (getTenant.queryParameters);
    const sync = /** @type {ContractObject} */ (contract.sync);

    expect(fields.map((field) => field.name)).toEqual(["code", "fields", "message"]);
    expect(getTenant.successes).toMatchObject([{ status: 200 }]);
    expect(getTenant.errors).toMatchObject([{ status: 401 }, { status: 404 }]);
    expect(query).toMatchObject([
      { name: "consistency", optional: false },
      { name: "expand", optional: true },
    ]);
    expect(sync.protocolVersion).toBe("1");
  });

  it("rejects trailing commas and reports the duplicate key start location exactly", async () => {
    await expect(canonicalJsonFixture(fixturePaths.invalidTrailingComma)).rejects.toThrow(/trailing-comma\.json:3:1: trailing comma/);
    await expect(canonicalJsonFixture(fixturePaths.invalidDuplicateKey)).rejects.toThrow(/duplicate-key\.json:3:3: duplicate key "version" \(first declared at 2:3\)/);
  });

  it("rejects unknown declaration kinds, duplicates, dangling refs, impossible constraints, and malformed operation or sync shapes", async () => {
    const unknownKind = await validContract();
    unknownKind.declarations[0].kind = "future";
    expect(() => canonicalizeContract(unknownKind)).toThrow(/unknown declaration kind/);

    const duplicateOperation = await validContract();
    duplicateOperation.http.groups[0].operations[1].id = duplicateOperation.http.groups[0].operations[0].id;
    expect(() => canonicalizeContract(duplicateOperation)).toThrow(/duplicate operation ID/);

    const duplicateFrame = await validContract();
    duplicateFrame.sync.frames[1].kind = duplicateFrame.sync.frames[0].kind;
    expect(() => canonicalizeContract(duplicateFrame)).toThrow(/duplicate sync frame kind/);

    const duplicateMessage = await validContract();
    duplicateMessage.sync.events[0].id = duplicateMessage.sync.commands[0].id;
    expect(() => canonicalizeContract(duplicateMessage)).toThrow(/duplicate sync message ID/);

    const impossibleConstraints = await validContract();
    const room = required(/** @type {ContractObject[]} */ (impossibleConstraints.declarations).find((declaration) => declaration.id === "chalk.Room"));
    const title = required(/** @type {ContractObject[]} */ (room.fields).find((field) => field.name === "title"));
    title.constraints = { maxLength: 1, minLength: 2 };
    expect(() => canonicalizeContract(impossibleConstraints)).toThrow(/minLength cannot exceed maxLength/);

    const malformedOperation = await validContract();
    delete malformedOperation.http.groups[0].operations[0].successes;
    expect(() => canonicalizeContract(malformedOperation)).toThrow(/successes: expected an array/);

    const malformedSync = await validContract();
    delete malformedSync.sync.connection;
    expect(() => canonicalizeContract(malformedSync)).toThrow(/connection: expected an object/);

    await expect(canonicalJsonFixture(fixturePaths.invalidDanglingReference)).rejects.toThrow(/unknown declaration reference/);
  });

  it("reports compiler and lowering failures at TypeSpec source locations", async () => {
    await expect(compileTypeSpecFixture(fixturePaths.invalidTypeSpecReference)).rejects.toThrow(/missing-reference\.tsp:\d+:\d+.*Unknown identifier/s);
    await expect(loadTypeSpecContract(fixturePaths.invalidTypeSpecLowering)).rejects.toThrow(/missing-discriminator\.tsp:\d+:\d+: Union MissingDiscriminator is missing an explicit discriminator/);
  });

  it("keeps both frontends deterministic across 20 runs", async () => {
    const jsonOutputs = [];
    const typeSpecOutputs = [];
    for (let run = 0; run < 20; run += 1) {
      jsonOutputs.push(await canonicalJsonFixture(fixturePaths.json));
      typeSpecOutputs.push(canonicalContractJson(await loadTypeSpecContract(fixturePaths.typeSpec)));
    }
    expect(new Set(jsonOutputs)).toHaveLength(1);
    expect(new Set(typeSpecOutputs)).toHaveLength(1);
    expect(typeSpecOutputs[0]).toBe(jsonOutputs[0]);
  }, 20_000);
});
