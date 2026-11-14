#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ts = createRequire(import.meta.url)("typescript");

// ast-grep parses JavaScript, TypeScript, and TSX separately. Keep each rule's
// intent here once, then give each grammar its own ID for precise suppressions.
const sourceLanguages = [
  ["js", "JavaScript"],
  ["ts", "TypeScript"],
  ["tsx", "Tsx"],
];
const appSources = ["apps/**/src/**", "packages/**/src/**", "sdks/typescript/**/src/**"];
const tests = ["**/*.test.*", "**/*.spec.*"];
const pattern = (value) => ({ pattern: value });
const anyPattern = (...values) => ({ any: values.map(pattern) });
const rules = [];

function addSourceRule(id, message, rule, { files, ignores, constraints } = {}) {
  for (const [suffix, language] of sourceLanguages) {
    rules.push({ id: `chalk.${id}-${suffix}`, language, severity: "error", message, rule, ...(files && { files }), ...(ignores && { ignores }), ...(constraints && { constraints }) });
  }
}

addSourceRule(
  "forbid-sdk-use-effect",
  "SDK effects need a per-call synchronization or lifecycle reason; derive render state and handle user actions without effects.",
  {
    any: [
      pattern("useEffect($$$ARGS)"),
      pattern("$REACT.useEffect($$$ARGS)"),
      {
        all: [
          pattern("$ALIAS($$$ARGS)"),
          {
            inside: {
              kind: "program",
              has: {
                all: [{ pattern: { context: 'import { useEffect as $ALIAS } from "react"', selector: "import_specifier" } }, { inside: { kind: "import_statement", has: { field: "source", regex: "^['\"]react['\"]$" }, stopBy: "end" } }],
                stopBy: "end",
              },
              stopBy: "end",
            },
          },
        ],
      },
    ],
  },
  { files: ["sdks/typescript/react/**", "sdks/typescript/react-native/**"], ignores: [...tests, "**/__tests__/**", "**/test/**", "**/tests/**", "**/dist/**", "**/node_modules/**"] },
);

const dynamicCodeExclusions = [...tests, "**/__tests__/**", "**/test/**", "**/dist/**", "**/coverage/**", "**/node_modules/**"];
addSourceRule("forbid-dynamic-code", "Avoid eval and new Function.", anyPattern("eval($$$ARGS)", "new Function($$$ARGS)"), { ignores: dynamicCodeExclusions });
addSourceRule("forbid-string-timers", "Avoid string-based timers.", anyPattern("setTimeout($ARG, $$$ARGS)", "setInterval($ARG, $$$ARGS)"), {
  ignores: dynamicCodeExclusions,
  constraints: { ARG: { any: [{ kind: "string" }, { kind: "template_string" }] } },
});

addSourceRule("forbid-focused-or-skipped-tests", "Do not commit focused or skipped tests.", anyPattern(...["test", "describe", "it"].flatMap((name) => ["only", "skip"].map((mode) => `${name}.${mode}($$$ARGS)`))), {
  files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
});

// A test may not replace a module of this repository: it would assert on wiring the author just wrote. Fake the real boundary (network, time, storage, a provider SDK, browser APIs) and run our own code.
// Match the call by its last name, not by the object it hangs on: `vi`, an aliased `vi`, `vitest.vi`, node:test's `mock` or `t.mock`, and `jest` all reach it. The specifier test keeps this to relative and repository-scoped paths.
const repoModuleSpecifier = "^['\"`](?:\\.{1,2}(?:/|['\"`])|@/|@chalk/|@q9labsai/)";
const mockCallees = ["$OBJ.mock", "$OBJ.doMock", "$OBJ.setMock", "$OBJ.unstable_mockModule", "$OBJ.module", "mock", "doMock", "setMock"];
// The import form comes first: ast-grep checks constraints against the first alternative that matches, and `$SPEC` alone would also bind `import("./own")` as a whole.
const mockSpecifiers = ["import($SPEC)", "$SPEC"];
addSourceRule(
  "forbid-own-module-mocks",
  "Do not mock a module of this repository. Run the real module and fake only the real boundary (network, time, storage, provider SDK, browser APIs); see CODING_STANDARDS.md.",
  anyPattern(...mockSpecifiers.flatMap((specifier) => mockCallees.flatMap((callee) => [`${callee}(${specifier})`, `${callee}(${specifier}, $$$REST)`]))),
  {
    constraints: { SPEC: { any: [{ kind: "string" }, { kind: "template_string" }], regex: repoModuleSpecifier } },
  },
);

addSourceRule(
  "forbid-unjustified-ts-ignore",
  "TypeScript and lint suppressions need a same-line justification.",
  { kind: "comment", regex: "^//\\s*(?:@ts-ignore|eslint-disable(?:-next-line|-line)?)\\s*$" },
  {
    ignores: [...tests, "**/__tests__/**", "**/routeTree.gen.ts", "**/generated/**", "**/openapi-generated/**"],
  },
);

addSourceRule(
  "forbid-unjustified-suppression",
  "Structural and lint suppressions need a same-line reason after --.",
  {
    all: [{ kind: "comment" }, { regex: "^\\s*(?://|/\\*)\\s*(?:ast-grep-ignore|(?:eslint|oxlint)-disable(?:-next-line|-line)?)(?:\\s|:|\\*/|$)" }, { not: { regex: "--\\s*[^\\s*]" } }],
  },
  { ignores: [...tests, "**/__tests__/**", "**/routeTree.gen.ts", "**/generated/**", "**/openapi-generated/**"] },
);

addSourceRule("forbid-console-in-app-code", "Route application logging through the repo logger or an approved diagnostics module.", anyPattern("console.log($$$ARGS)", "console.error($$$ARGS)"), {
  files: appSources,
  ignores: [...tests, "**/debug/**", "**/diagnostics/**", "sdks/typescript/client/src/wide-events/**", "sdks/typescript/react/src/utils/debug*.ts", "sdks/typescript/react/src/components/composite/DiagnosticErrorSheet.tsx"],
});

addSourceRule("forbid-direct-process-env", "Read environment through approved config modules, app config, or scripts.", pattern("process.env.$NAME"), {
  files: [...appSources, "infrastructure/**/src/**"],
  ignores: [...tests, "apps/mobile/src/lib/chalk.ts", "apps/mobile/src/lib/dev-diagnostics.ts"],
});

addSourceRule(
  "forbid-raw-token-storage",
  "Do not persist auth/session/token material through raw browser storage.",
  anyPattern("localStorage.setItem($KEY, $$$ARGS)", "sessionStorage.setItem($KEY, $$$ARGS)", "window.localStorage.setItem($KEY, $$$ARGS)", "window.sessionStorage.setItem($KEY, $$$ARGS)"),
  {
    ignores: [...tests, "sdks/typescript/client/src/token-provider.ts"],
    constraints: { KEY: { regex: "token|auth|session|secret|key" } },
  },
);

addSourceRule(
  "forbid-empty-catch",
  "An empty catch hides the failure. Handle the error, log it with context, or say in a comment inside the catch why dropping it is safe.",
  {
    any: [{ kind: "catch_clause", has: { field: "body", regex: "^\\{\\s*\\}$" } }, { all: [pattern("$PROMISE.catch(() => {})"), { not: { regex: "/[/*]" } }] }],
  },
  {
    files: ["apps/web/server/**", "apps/web/src/**", "packages/ui/src/**", "packages/whiteboard/src/**", "packages/facehash/src/**", "packages/transcript-language/src/**", "packages/assets/src/**"],
    // The call-state harness is a proof fixture owned by the call session work; its two silent catches wait for that change.
    ignores: [...tests, "**/__tests__/**", "apps/web/src/call-states/**"],
  },
);

addSourceRule(
  "forbid-sdk-importing-app-code",
  "SDK packages must not import app-only modules.",
  {
    any: [
      { kind: "import_statement", regex: "from\\s+['\"](?:\\.\\./)*apps/" },
      { kind: "export_statement", regex: "from\\s+['\"](?:\\.\\./)*apps/" },
    ],
  },
  {
    files: ["packages/assets/src/**", "sdks/typescript/client/src/**", "sdks/typescript/react/src/**", "sdks/typescript/react-native/src/**", "packages/whiteboard/src/**"],
  },
);

addSourceRule(
  "forbid-shell-true-with-interpolation",
  "Avoid interpolating untrusted values into shell commands.",
  {
    all: [{ kind: "call_expression" }, { has: { field: "function", regex: "(exec|spawn)" } }, { has: { field: "arguments", has: { kind: "object", has: { kind: "pair", all: [{ has: { field: "key", regex: "^shell$" } }, { has: { field: "value", kind: "true" } }] } } } }],
  },
  {
    files: ["scripts/**", "apps/**/scripts/**", "packages/**/scripts/**"],
  },
);

rules.push(
  {
    id: "chalk.forbid-placeholder-scripts-json",
    language: "Json",
    severity: "error",
    message: "Package scripts must not be placeholders or use --passWithNoTests.",
    files: ["**/package.json"],
    rule: {
      any: [
        { kind: "pair", all: [{ has: { field: "key", regex: '^"(?:lint|test)"$' } }, { has: { field: "value", regex: "^\"(?:echo 'No (?:linter|tests?) configured yet'|true|exit 0)\"$" } }] },
        { kind: "string", regex: "--passWithNoTests" },
      ],
    },
  },
  {
    id: "chalk.forbid-source-path-package-exports-json",
    language: "Json",
    severity: "error",
    message: "Publishable package exports should point at built artifacts, not source paths.",
    files: ["packages/*/package.json", "sdks/typescript/*/package.json"],
    rule: { kind: "pair", all: [{ has: { field: "key", regex: '^"(?:import|require|default|types|react-native)"$' } }, { has: { field: "value", regex: '^"\\./src/' } }] },
  },
);

// The old generic rule also applies to generated TypeScript, not only OpenAPI YAML.
for (const [suffix, language] of [["yaml", "Yaml"], ...sourceLanguages]) {
  rules.push({
    id: `chalk.forbid-generated-openapi-stubs-${suffix}`,
    language,
    severity: "error",
    message: "Generated OpenAPI stubs and TODO operations must be enriched before commit.",
    files: ["apps/api/openapi.yaml", "sdks/typescript/client/src/generated/**", "sdks/typescript/client/openapi-generated/**"],
    rule: {
      any: [
        { kind: "comment", regex: "TODO: document" },
        { kind: language === "Yaml" ? "string_scalar" : "string", regex: "TODO: document" },
        { kind: language === "Yaml" ? "block_mapping_pair" : "pair", regex: "x-generated-stub:\\s*true" },
      ],
    },
  });
}

// ast-grep honors `// ast-grep-ignore` on or above a line, and a trailing one hides the comment itself too, so a rule cannot
// guard against it. Check the comments as text instead: a suppression must name its rule, and may not name the own-module mock ban.
// A block comment can carry the rule list over several lines, and a string such as "https://x" must not pass for a comment,
// so the comments are the ones the TypeScript parser finds, read whole.
const sourceFile = /\.[cm]?[jt]sx?$/u;
function commentRanges(file, text) {
  const jsx = /x$/u.test(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map();
  const visit = (node) => {
    for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) found.set(range.pos, range);
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return [...found.values()];
}
const forbiddenSuppression = /ast-grep-ignore(?!\s*:)|ast-grep-ignore\s*:[\s\S]*forbid-own-module-mocks/u;
function forbiddenSuppressions(paths) {
  const listed = spawnSync("git", ["grep", "--no-index", "--exclude-standard", "-l", "-E", "ast-grep-ignore", "--", ...(paths.length > 0 ? paths : ["."]), ":!scripts/gates/ast-grep*"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (listed.status !== 0 && listed.status !== 1) throw new Error(`git grep failed: ${listed.stderr}`);
  return listed.stdout
    .split("\n")
    .filter((file) => sourceFile.test(file))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return commentRanges(file, text)
        .map((range) => ({ range, body: text.slice(range.pos, range.end) }))
        .filter(({ body }) => forbiddenSuppression.test(body))
        .map(({ range, body }) => `${file}:${text.slice(0, range.pos).split("\n").length}: ${body.split("\n", 1)[0]}`);
    });
}

const args = process.argv.slice(2);
const suppressions = forbiddenSuppressions(args.filter((arg) => !arg.startsWith("-")));
for (const line of suppressions) console.error(`${line}\n  Name the rule you suppress (ast-grep-ignore: <rule> -- reason); a blanket ignore, or one naming forbid-own-module-mocks, would hide a mock of a module of this repository.`);

const binary = process.env.AST_GREP_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin/ast-grep");
const result = spawnSync(binary, ["scan", "--inline-rules", rules.map((rule) => JSON.stringify(rule)).join("\n---\n"), ...args], { stdio: "inherit" });
if (result.error) console.error(`Could not run ast-grep: ${result.error.message}`);
process.exitCode = suppressions.length > 0 ? 1 : (result.status ?? 1);
