const { makeHexagonalRules } = require("@q9labsai/config-depcruise");

const PACKAGE_ALIAS_DEPENDENCY_TYPES = ["aliased", "aliased-workspace"];

const canonicalConfiguration = makeHexagonalRules({
  core: [],
  edges: [],
  exclude: ["^scratchpad/"],
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

const webSectionsStandAlone = {
  name: "web-sections-stand-alone",
  comment: "The landing, docs, dashboard and space sections of the web app do not import each other. Shared pieces live in components/site or components/privacy.",
  severity: "error",
  from: { path: "^apps/web/src/components/(landing|docs|dashboard|space)/" },
  to: { path: "^apps/web/src/components/(landing|docs|dashboard|space)/", pathNot: "^apps/web/src/components/$1/" },
};

const webSharedSectionsAreLeaves = {
  name: "web-shared-sections-are-leaves",
  comment: "components/site and components/privacy are what the sections share, so they import no section back.",
  severity: "error",
  from: { path: "^apps/web/src/components/(site|privacy)/" },
  to: { path: "^apps/web/src/components/(landing|docs|dashboard|space)/" },
};

const dashboardServerHasNoUi = {
  name: "dashboard-server-has-no-ui",
  comment: "The Pages Function bundle imports no component or route of the browser app.",
  severity: "error",
  from: { path: "^apps/web/server/" },
  to: { path: "^apps/web/src/(components|routes)/" },
};

const whiteboardCoreIsFrameworkNeutral = {
  name: "whiteboard-core-is-framework-neutral",
  comment: "The collab core and the embedded protocol and bridge are framework-neutral contracts, so they import nothing from the React folder.",
  severity: "error",
  from: { path: "^packages/whiteboard/src/(collab/|embedded/(protocol|renderer-bridge))" },
  to: { path: "^packages/whiteboard/src/react/" },
};

const clientAccessCannotReachConnection = {
  name: "client-access-does-not-import-connection",
  comment: "Access types and refresh logic sit below the connection lifecycle; shared shapes live in access/context.ts.",
  severity: "error",
  from: { path: "(?:^|/)sdks/typescript/client/src/access/" },
  to: { path: "(?:^|/)sdks/typescript/client/src/connection/" },
};

const clientServerEntryCannotReachSpaceClient = {
  name: "client-server-entry-does-not-import-space-client",
  comment: "The server entry stays free of the browser SpaceClient; shared types live with their owning module.",
  severity: "error",
  from: { path: "(?:^|/)sdks/typescript/client/src/server/" },
  to: { path: "(?:^|/)sdks/typescript/client/src/space-client/" },
};

const smallAppsHaveNoCycles = {
  name: "dispatcher-renderer-mobile-no-cycles",
  comment: "These apps are acyclic today; a new import cycle (type-only imports included) means a shared piece belongs in a lower module.",
  severity: "error",
  from: { path: "(?:^|/)apps/(?:transcription-dispatcher|recording-renderer|mobile)/(?:src|App\\.tsx)" },
  to: { circular: true },
};

module.exports = {
  // This lane owns inter-workspace direction only; intra-workspace cycle and dependency policy stays in broader quality work.
  forbidden: [
    webSectionsStandAlone,
    webSharedSectionsAreLeaves,
    dashboardServerHasNoUi,
    whiteboardCoreIsFrameworkNeutral,
    packageSourceCannotReachOtherPackageSource,
    packageSourceCannotReachSdkSource,
    sdkSourceCannotReachPackageSource,
    sdkSourceCannotReachOtherSdkSource,
    appSourceCannotReachWorkspaceSource,
    workspaceSourceCannotReachAppSource,
    clientAccessCannotReachConnection,
    clientServerEntryCannotReachSpaceClient,
    smallAppsHaveNoCycles,
  ],
  options: {
    ...canonicalConfiguration.options,
    includeOnly: { path: "^(?:apps|packages|sdks/typescript)(?:/|$)" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
