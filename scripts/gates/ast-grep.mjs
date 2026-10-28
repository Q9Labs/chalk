#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  "SDK effects need an explicit per-call exception with a reason; prefer subscriptions and event handlers.",
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
  { files: ["sdks/typescript/react/**", "sdks/typescript/react-native/**"] },
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

addSourceRule(
  "forbid-unjustified-ts-ignore",
  "TypeScript and lint suppressions need a same-line justification.",
  { kind: "comment", regex: "^//\\s*(?:@ts-ignore|eslint-disable(?:-next-line|-line)?)\\s*$" },
  {
    ignores: [...tests, "**/__tests__/**", "**/routeTree.gen.ts", "**/generated/**", "**/openapi-generated/**"],
  },
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

const binary = process.env.AST_GREP_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin/ast-grep");
const result = spawnSync(binary, ["scan", "--inline-rules", rules.map((rule) => JSON.stringify(rule)).join("\n---\n"), ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(`Could not run ast-grep: ${result.error.message}`);
process.exitCode = result.status ?? 1;
