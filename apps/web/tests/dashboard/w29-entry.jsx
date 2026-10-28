import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "w29-sdk";

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

// The integration prepares access before constructing its SDK client. Changing
// the action dependency invalidates the in-flight result via an active flag.
const root = createRoot(document.getElementById("root"));
function Preparation({ action }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    record("prepare");
    action().then(() => { if (active) { record("prepared"); setReady(true); } else record("discarded"); });
    return () => { active = false; record("invalidated"); };
  }, [action]);
  return <div>{ready ? "ready" : "preparing"}</div>;
}
window.prepare = () => root.render(<Preparation action={() => window.access({ reason: "join", preparation: true })} />);
window.unmountPreparation = () => root.unmount();
window.recordDone = () => record("done");
