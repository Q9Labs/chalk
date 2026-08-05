// @ts-check

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const proofSchemaDirectory = resolve(repositoryRoot, "contract/schema/proof");
const generatedDirectory = resolve(repositoryRoot, "contract/generated");

export const fixturePaths = {
  json: resolve(proofSchemaDirectory, "chalk.json"),
  typeSpec: resolve(proofSchemaDirectory, "chalk.tsp"),
  invalidDuplicateId: resolve(proofSchemaDirectory, "invalid/duplicate-declaration-id.json"),
  invalidDanglingReference: resolve(proofSchemaDirectory, "invalid/dangling-reference.json"),
  invalidDuplicateKey: resolve(proofSchemaDirectory, "invalid/duplicate-key.json"),
  invalidTrailingComma: resolve(proofSchemaDirectory, "invalid/trailing-comma.json"),
  invalidTypeSpecReference: resolve(proofSchemaDirectory, "invalid/missing-reference.tsp"),
  invalidTypeSpecLowering: resolve(proofSchemaDirectory, "invalid/missing-discriminator.tsp"),
};

export const generatedPaths = {
  ir: resolve(generatedDirectory, "frontend-proof.ir.json"),
  report: resolve(generatedDirectory, "frontend-proof.report.md"),
};
