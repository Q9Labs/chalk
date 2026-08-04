import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("SpaceLifecyclePhase", () => {
  it("keeps the exported source contract on the canonical native phases", () => {
    const sourcePath = fileURLToPath(new URL("./space-lifecycle.ts", import.meta.url));
    const sourceFile = ts.createSourceFile("space-lifecycle.ts", readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === "SpaceLifecyclePhase");

    expect(declaration).toBeDefined();
    if (!declaration || !ts.isUnionTypeNode(declaration.type)) throw new Error("SpaceLifecyclePhase must remain an exported string union.");

    expect(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    const phases = declaration.type.types.map((member) => (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : "<invalid>"));
    expect(phases).toEqual(["entrance", "joining", "live", "left"]);
  });
});
