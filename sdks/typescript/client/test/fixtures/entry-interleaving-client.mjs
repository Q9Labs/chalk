import { build } from "esbuild";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Bundle current source, never a possibly stale dist left by another gate lane.
const sdk = new URL("../../", import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL("src/sync/v1-client.ts", sdk))], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { V1SyncClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
let client;
let upgraded = false;
let token;
let entered = 0;
let acknowledged = 0;
let welcomes = 0;
let generation = null;
let operation;
let operationReply;
let recoveryMode;
const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Client step timed out (${client?.getSnapshot().connection.phase})`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const status = () => ({ entered, acknowledged, generation, welcomes, operation, operationReply, recoveryMode, phase: client?.getSnapshot().connection.phase });
const recordWelcome = (frame) => {
  welcomes++;
  generation = frame.entry_generation ?? null;
  recoveryMode = frame.mode;
};
const commands = {
  async start(input) {
    client?.stop();
    upgraded = false;
    token = input.token;
    entered = acknowledged = welcomes = 0;
    generation = operation = operationReply = recoveryMode = null;
    client = new V1SyncClient({
      url: `ws://127.0.0.1:${input.port}/v1/sync`,
      token: async () => token,
      entryConfirmation: true,
      webSocket: {
        connect(url) {
          const target = new URL(url);
          // The previous Sync protocol ignores entry negotiation and confirms hello.
          // Exercise that protocol on the real server's supported legacy route.
          if (!upgraded) target.search = "";
          const socket = new WebSocket(target);
          const send = socket.send.bind(socket);
          socket.send = (value) => {
            const frame = JSON.parse(value);
            if (frame.type === "entered") entered++;
            if (frame.type === "operation" && frame.name === "participant_leave") operation = frame.command_id;
            send(value);
          };
          socket.addEventListener("message", ({ data }) => {
            const frame = JSON.parse(data);
            switch (frame.type) {
              case "welcome":
                recordWelcome(frame);
                break;
              case "entered_ack":
                acknowledged++;
                break;
            }
            if (frame.command_id === operation) operationReply = frame.type;
          });
          return socket;
        },
      },
    });
    await client.start();
    await waitFor(() => client.getSnapshot().connection.phase === "live");
    await client.confirmEntered();
    return status();
  },
  async upgrade() {
    upgraded = true;
    return status();
  },
  async refresh(input) {
    token = input.token;
    return status();
  },
  async reconnect() {
    const before = welcomes;
    const beforeAck = acknowledged;
    client.restartTransport();
    try {
      await waitFor(() => welcomes > before && client.getSnapshot().connection.phase === "live");
    } catch {
      return status();
    }
    if (upgraded) await waitFor(() => acknowledged > beforeAck).catch(() => {});
    return status();
  },
  async leave() {
    client.leave({ commandId: "interleaving_sdk_leave_0001" }).catch(() => {});
    await waitFor(() => operationReply !== null);
    return status();
  },
  async close() {
    client?.stop();
    client = undefined;
    return {};
  },
};
const idle = setTimeout(() => {
  client?.stop();
  process.exit(2);
}, 60000);
idle.unref();
try {
  for await (const line of createInterface({ input: process.stdin })) {
    idle.refresh();
    const input = JSON.parse(line);
    try {
      process.stdout.write(`${JSON.stringify({ result: await commands[input.step](input) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    }
  }
} finally {
  client?.stop();
  clearTimeout(idle);
}
