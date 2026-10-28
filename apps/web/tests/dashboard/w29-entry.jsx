import React from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "w29-sdk";
import { ChalkClassroom } from "w29-th";

window.audit = [];
const started = performance.now();
const record = (event, fields = {}) => window.audit.push({ event, ms: Math.round(performance.now() - started), ...fields });
window.WebSocket = new Proxy(window.WebSocket, {
  construct(Target, args) {
    const socket = new Target(...args);
    record("socket_construct");
    socket.addEventListener("open", () => record("socket_open"));
    socket.addEventListener("close", (event) => record("socket_close", { code: event.code }));
    return socket;
  },
});
let client;
window.startClient = (options) => {
  client = createSpaceClientForPlatform(
    { space: options.space, baseUrl: options.api, getAccess: async (request) => { record("provider", { reason: request.reason }); return window.access(request); } },
    { apiBaseUrl: options.api, syncUrl: options.sync, whiteboardUrl: null, onConnectionDiagnostic: (event) => record(event.event, { code: event.code, state: event.state }) },
  );
  client.subscribe(() => record("state", { state: client.getSnapshot().connection.status, code: client.getSnapshot().connection.lastError?.code }));
  window.joining = client.join({ microphone: false, camera: false }).then(() => record("join_ok"), (error) => record("join_failed", { code: error.code }));
};
window.stopClient = async () => { client?.dispose(); await window.joining; };

// The exact private integration source is supplied to the disposable runner,
// never committed here. Only its external Convex/UI adapters are substituted.
const root = createRoot(document.getElementById("root"));
window.prepare = () => root.render(<ChalkClassroom portal="teacher" target={{ kind: "class", classSessionId: "synthetic-w29" }} />);
window.unmountPreparation = () => root.unmount();
window.recordDone = () => record("done");
