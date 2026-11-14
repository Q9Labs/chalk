import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { waitFor } from "./runtime.mjs";

const requireSDK = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));

export async function loadSdk(run, name, entry) {
  const outfile = `${run.directory}/sdk-${name}.mjs`;
  await requireSDK("esbuild").build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", nodePaths: [new URL("../../sdks/typescript/client/node_modules", import.meta.url).pathname], logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

// The SDK's own socket adapter does the work; this subclass only copies what the SDK later decodes.
function wire(sdk) {
  const seen = { welcome: undefined, media: [], closes: 0 };
  class TappedWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      this.addEventListener("close", () => seen.closes++);
      this.addEventListener("message", (event) => tap(seen, JSON.parse(String(event.data))));
    }
  }
  return { seen, webSocket: sdk.createBrowserWebSocketFactory(TappedWebSocket) };
}

function tap(seen, frame) {
  if (frame.type === "welcome") seen.welcome = Object.fromEntries(Object.entries(frame).filter(([name]) => name === "media_off_reason"));
  else if (frame.stream === "media") seen.media.push(frame);
}

const idleLifecycle = {
  subscribe(listener) {
    listener("online");
    return () => {};
  },
};

export async function connect(run, clients, sdk, url, token) {
  const { seen, webSocket } = wire(sdk);
  const client = sdk.createV1SyncClient({ url, token: async () => token, webSocket, lifecycle: idleLifecycle, page: null });
  clients.push(client);
  await client.start();
  await waitFor("Sync connection live", async () => client.getSnapshot().connection.phase === "live", 30_000, 200, run.signal);
  return { client, seen };
}
