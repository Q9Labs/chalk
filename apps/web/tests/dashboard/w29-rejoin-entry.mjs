import { createSpaceClientForPlatform } from "../../../../sdks/typescript/client/src/space-client/space-client.ts";
const sockets = new Set();
const clients = new Map();
window.socketEvents = [];
window.WebSocket = new Proxy(window.WebSocket, {
  construct(Target, args) {
    const socket = new Target(...args);
    sockets.add(socket);
    const path = new URL(args[0]).pathname;
    window.socketEvents.push({ event: "created", path });
    socket.addEventListener("open", () => window.socketEvents.push({ event: "opened", path }));
    socket.addEventListener("close", (event) => window.socketEvents.push({ event: "closed", path, code: event.code }));
    return socket;
  },
});
window.socketCounts = () => Object.fromEntries([0, 1, 2, 3].map((state) => [state, [...sockets].filter((socket) => socket.readyState === state).length]));
window.joinClient = async ({ label, space, api, sync }) => {
  const client = createSpaceClientForPlatform({ space, baseUrl: api, getAccess: (request) => window.access(label, request) }, { apiBaseUrl: api, syncUrl: sync, whiteboardUrl: new URL("/v1/whiteboard", sync).href });
  clients.set(label, client);
  try {
    await client.join({ microphone: false, camera: false });
    const board = await client.whiteboard.transport();
    await board.startSceneSubscription();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code };
  }
};
window.leaveClient = async (label) => {
  await clients.get(label).leave();
};
window.disposeClients = () => {
  for (const client of clients.values()) client.dispose();
};
