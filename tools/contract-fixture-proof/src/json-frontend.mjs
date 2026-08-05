// @ts-check

import { readFile } from "node:fs/promises";
import { canonicalContractJson, ContractValidationError } from "./contract-ir.mjs";
import { JsonSourceDiagnostic, LocationPreservingJsonParser } from "./json-parser.mjs";

const sourceMetadata = new WeakMap();

/**
 * @param {string} path
 */
async function loadJsonContract(path) {
  const source = await readFile(path, "utf8");
  try {
    const parsed = new LocationPreservingJsonParser(source).parse();
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
      throw new JsonSourceDiagnostic("contract root must be an object", "contract", { column: 1, line: 1 });
    }
    sourceMetadata.set(parsed.value, { locations: parsed.locations, path });
    return parsed.value;
  } catch (error) {
    if (error instanceof JsonSourceDiagnostic) {
      throw new Error(`${path}:${error.location.line}:${error.location.column}: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Chalk JSON contract fixture at ${path}: ${message}`);
  }
}

/**
 * @param {unknown} contract
 * @param {string} issue
 */
function sourceLocationFor(contract, issue) {
  if (typeof contract !== "object" || contract === null) {
    return undefined;
  }
  const metadata = sourceMetadata.get(contract);
  const path = issue.slice(0, issue.indexOf(":"));
  const location = metadata?.locations.get(path);
  return location ? `${metadata.path}:${location.line}:${location.column}` : undefined;
}

/**
 * @param {string} path
 */
export async function canonicalJsonFixture(path) {
  const contract = await loadJsonContract(path);
  try {
    return canonicalContractJson(contract);
  } catch (error) {
    if (!(error instanceof ContractValidationError)) {
      throw error;
    }
    const diagnostics = error.issues.map((issue) => {
      const location = sourceLocationFor(contract, issue);
      return location ? `${location}: ${issue}` : issue;
    });
    throw new Error(`Invalid Chalk JSON contract fixture:\n${diagnostics.join("\n")}`);
  }
}
