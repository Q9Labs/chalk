import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Resolve every SDK reference from the installed tarballs, never workspace sources.
// Ambient values stand only for application-owned inputs omitted by the prose.
export async function checkDocExamples(repository, consumer, run) {
  const directory = join(consumer, "docs-examples");
  await mkdir(directory);
  const content = "apps/web/src/docs/content";
  const paths = (await readdir(join(repository, content)))
    .filter((name) => name.endsWith(".mdx"))
    .sort()
    .map((name) => `${content}/${name}`);
  paths.push("sdks/typescript/react/README.md", "sdks/typescript/client/README.md", "sdks/typescript/react-native/README.md", "sdks/typescript/client/docs/webhooks.md", "docs/sdk-web-quickstart.md");
  const bindings = [
    "client",
    "spaceClient",
    "createSpaceClient",
    "Chalk",
    "getAccess",
    "file",
    "participantId",
    "requestId",
    "renderParticipant",
    "statusView",
    "renderConnection",
    "renderStatus",
    "announce",
    "reportSafeDiagnostic",
    "showRetry",
    "stop",
    "classNames",
    "icons",
    "durableInbox",
    "loadCurrentAndPreviousSecrets",
    "crm",
    "chalk",
    "space",
    "episode",
    "admission",
    "request",
    "tenantId",
    "processor",
    "toWebhookResponse",
    "showEpisodeHistory",
    "storeSecret",
  ];
  await writeFile(
    join(directory, "inputs.ts"),
    `
import type { GetAccess, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { ChalkServerClient } from "@q9labsai/chalk-client/server";
import type { WebhookInbox } from "@q9labsai/chalk-client/webhooks";
import type { ComponentProps } from "react";
import type { WhiteboardCanvas } from "@q9labsai/chalk-whiteboard/react";
export { createSpaceClient } from "@q9labsai/chalk-client";
export { toWebhookResponse } from "@q9labsai/chalk-client/webhooks";
export declare const processor: ReturnType<typeof import("@q9labsai/chalk-client/webhooks").createWebhookProcessor>;
export declare const showEpisodeHistory: (id: string | undefined) => void;
export declare const storeSecret: (secret: unknown) => Promise<void>;
export { Chalk } from "@q9labsai/chalk-react";
export declare const client: SpaceClient, spaceClient: SpaceClient;
export declare const getAccess: GetAccess;
export declare const file: File;
export declare const participantId: string, requestId: string, tenantId: string;
export declare const renderParticipant: (value: { name: string; connected: boolean; speaking: boolean }) => void;
export declare const statusView: { set: (value: SpaceSnapshot["connection"]["status"]) => void };
export declare const renderConnection: (status: string, error?: unknown) => void;
export declare const renderStatus: typeof renderConnection;
export declare const announce: (message: string) => void;
export declare const reportSafeDiagnostic: (code: string, recoverable: boolean) => void;
export declare const showRetry: (message: string) => void;
export declare const stop: () => void;
export declare const classNames: ComponentProps<typeof WhiteboardCanvas>["classNames"];
export declare const icons: ComponentProps<typeof WhiteboardCanvas>["icons"];
export declare const durableInbox: WebhookInbox;
export declare const loadCurrentAndPreviousSecrets: () => Promise<readonly string[]>;
export declare const crm: { upsertParticipant: (value: unknown, options: { idempotencyKey: string }) => Promise<void> };
export declare const chalk: ChalkServerClient;
export declare const space: Awaited<ReturnType<ChalkServerClient["spaces"]["create"]>>;
export declare const episode: Awaited<ReturnType<ChalkServerClient["episodes"]["create"]>>;
type Admission = Awaited<ReturnType<ChalkServerClient["participants"]["admit"]>>;
export declare const admission: Omit<Admission, "access"> & { access: NonNullable<Admission["access"]> };
export declare const request: { body: Parameters<ChalkServerClient["participants"]["issueAccess"]>[4] };
`,
  );
  await writeFile(join(directory, "access.ts"), 'export { getAccess } from "./inputs";\n');
  const globals = bindings
    .filter((name) => name !== "stop")
    .map((name) => `const ${name}: typeof import("./inputs").${name};`)
    .join("\n");
  await writeFile(join(directory, "application.d.ts"), `export {};\ndeclare global {\n${globals}\nfunction stop(): void;\n}\n`);
  let count = 0;
  for (const path of paths) {
    const markdown = await readFile(join(repository, path), "utf8");
    let block = 0;
    for (const match of markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)) {
      block++;
      const language = match[1].trim();
      if (!["ts", "tsx", "typescript"].includes(language)) continue;
      const source = match[2];
      const code = `export {};\n${source}`;
      const name = `${path.replaceAll("/", "_").replace(/\.[^.]+$/, "")}-${block}.tsx`;
      await writeFile(join(directory, name), code);
      count++;
    }
  }
  await writeFile(join(consumer, "docs-tsconfig.json"), JSON.stringify({ extends: "./tsconfig.json", include: ["docs-examples/**/*.ts", "docs-examples/**/*.tsx"] }));
  await run("pnpm", ["exec", "tsc", "--project", "docs-tsconfig.json"], consumer);
  process.stdout.write(`[packed-docs] ${count} TypeScript/TSX examples from ${paths.length} public docs files passed against packed SDKs\n`);
}
