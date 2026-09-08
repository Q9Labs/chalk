const { makeHexagonalRules } = require("@q9labsai/config-depcruise");

const PACKAGE_ALIAS_DEPENDENCY_TYPES = ["aliased", "aliased-workspace"];

const canonicalConfiguration = makeHexagonalRules({
  core: [],
  edges: [],
  exclude: ["(?:^|/)scripts/gates/fixtures/package-boundaries/"],
});
const canonicalPackageSourceRule = canonicalConfiguration.forbidden.find((rule) => rule.name === "no-cross-package-src-imports");

if (canonicalPackageSourceRule === undefined) {
  throw new Error("@q9labsai/config-depcruise did not provide no-cross-package-src-imports");
}

const packageSourceCannotReachOtherPackageSource = {
  ...canonicalPackageSourceRule,
  to: {
    ...canonicalPackageSourceRule.to,
    dependencyTypesNot: PACKAGE_ALIAS_DEPENDENCY_TYPES,
  },
};

const appSourceCannotReachWorkspaceSource = {
  name: "apps-use-package-entrypoints",
  comment: "Applications must consume workspace packages through package entrypoints, not relative paths into package or SDK source.",
  severity: "error",
  from: { path: "(?:^|/)apps/[^/]+/src(?:/|$)" },
  to: {
    dependencyTypesNot: PACKAGE_ALIAS_DEPENDENCY_TYPES,
    path: "(?:^|/)(?:packages/[^/]+|sdks/typescript/[^/]+)/src(?:/|$)",
  },
};

const packageSourceCannotReachSdkSource = {
  name: "packages-use-sdk-entrypoints",
  comment: "Packages must consume SDKs through package entrypoints, not relative paths into SDK source.",
  severity: "error",
  from: { path: "(?:^|/)packages/[^/]+/src(?:/|$)" },
  to: {
    dependencyTypesNot: PACKAGE_ALIAS_DEPENDENCY_TYPES,
    path: "(?:^|/)sdks/typescript/[^/]+/src(?:/|$)",
  },
};

const sdkSourceCannotReachPackageSource = {
  name: "sdks-use-package-entrypoints",
  comment: "SDKs must consume packages through package entrypoints, not relative paths into package source.",
  severity: "error",
  from: { path: "(?:^|/)sdks/typescript/[^/]+/src(?:/|$)" },
  to: {
    dependencyTypesNot: PACKAGE_ALIAS_DEPENDENCY_TYPES,
    path: "(?:^|/)packages/[^/]+/src(?:/|$)",
  },
};

const sdkSourceCannotReachOtherSdkSource = {
  name: "sdks-use-sdk-entrypoints",
  comment: "SDKs must consume other SDKs through package entrypoints, not relative paths into their source.",
  severity: "error",
  from: { path: "(?:^|/)sdks/typescript/([^/]+)/src(?:/|$)" },
  to: {
    dependencyTypesNot: PACKAGE_ALIAS_DEPENDENCY_TYPES,
    path: "(?:^|/)sdks/typescript/(?!$1/)[^/]+/src(?:/|$)",
  },
};

const workspaceSourceCannotReachAppSource = {
  name: "workspace-packages-do-not-import-apps",
  comment: "Packages and SDKs must not depend on application source; dependency direction points toward packages.",
  severity: "error",
  from: { path: "(?:^|/)(?:packages/[^/]+|sdks/typescript/[^/]+)/src(?:/|$)" },
  to: { path: "(?:^|/)apps/[^/]+/src(?:/|$)" },
};

module.exports = {
  // This lane owns inter-workspace direction only; intra-workspace cycle and dependency policy stays in broader quality work.
  forbidden: [packageSourceCannotReachOtherPackageSource, packageSourceCannotReachSdkSource, sdkSourceCannotReachPackageSource, sdkSourceCannotReachOtherSdkSource, appSourceCannotReachWorkspaceSource, workspaceSourceCannotReachAppSource],
  options: {
    ...canonicalConfiguration.options,
    includeOnly: { path: "^(?:apps|packages|sdks/typescript)(?:/|$)" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
