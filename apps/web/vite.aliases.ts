import { fileURLToPath } from "node:url";

// Workspace packages resolve to their sources, so the app and the call-state harness run unbuilt SDK code.
export const sourceAliases = [
  { find: /^@q9labsai\/chalk-client\/effect$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/effect.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-client$/, replacement: fileURLToPath(new URL("../../sdks/typescript/client/src/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-react\/ui$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/components/ui/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-react\/utils$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/utils/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-react\/preview$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/test-support/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-react$/, replacement: fileURLToPath(new URL("../../sdks/typescript/react/src/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-ui$/, replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)) },
  { find: "@q9labsai/chalk-ui/assets", replacement: fileURLToPath(new URL("../../packages/ui/src/assets.ts", import.meta.url)) },
  { find: "@q9labsai/chalk-ui/button", replacement: fileURLToPath(new URL("../../packages/ui/src/button.tsx", import.meta.url)) },
  { find: "@q9labsai/chalk-ui/reactions", replacement: fileURLToPath(new URL("../../packages/ui/src/reactions.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-assets$/, replacement: fileURLToPath(new URL("../../packages/assets/src/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-whiteboard\/react$/, replacement: fileURLToPath(new URL("../../packages/whiteboard/src/react/index.ts", import.meta.url)) },
  { find: /^@q9labsai\/chalk-whiteboard$/, replacement: fileURLToPath(new URL("../../packages/whiteboard/src/index.ts", import.meta.url)) },
  { find: "@q9labsai/facehash/react", replacement: fileURLToPath(new URL("../../packages/facehash/src/react.ts", import.meta.url)) },
  { find: "@q9labsai/facehash", replacement: fileURLToPath(new URL("../../packages/facehash/src/index.ts", import.meta.url)) },
];
