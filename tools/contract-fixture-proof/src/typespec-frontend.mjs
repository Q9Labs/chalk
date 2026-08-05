// @ts-check

import { compile, formatDiagnostic, NodeHost } from "@typespec/compiler";
import { lowerTypeSpecProgram, TypeSpecLoweringError } from "./typespec-lowering.mjs";

/**
 * @param {string} path
 */
export async function compileTypeSpecFixture(path) {
  const program = await compile(NodeHost, path, { noEmit: true });
  const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`Invalid Chalk TypeSpec contract fixture at ${path}:\n${errors.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n")}`);
  }
  return program;
}

/**
 * @param {string} path
 */
export async function loadTypeSpecContract(path) {
  try {
    return lowerTypeSpecProgram(await compileTypeSpecFixture(path));
  } catch (error) {
    if (error instanceof TypeSpecLoweringError) {
      throw new Error(`Invalid Chalk TypeSpec contract fixture at ${error.location}: ${error.message}`);
    }
    throw error;
  }
}
