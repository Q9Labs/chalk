import { createRoot } from "react-dom/client";
import "../styles.css";
import { installFakeDevices } from "./media";
import { CALL_STATES } from "./states";

declare global {
  interface Window {
    __CALL_STATES__?: readonly Omit<(typeof CALL_STATES)[number], "render">[];
  }
}

window.__CALL_STATES__ = CALL_STATES.map(({ render: _render, ...meta }) => meta);
const id = new URLSearchParams(location.search).get("state");
const state = CALL_STATES.find((candidate) => candidate.id === id);
installFakeDevices({ blocked: state?.cameraBlocked === true });

const root = document.getElementById("root");
if (!root) throw new Error("call-states.html has no #root element.");
// No StrictMode: its doubled effects in development change what the board shows while it loads.
createRoot(root).render(state ? state.render() : <StateIndex />);

function StateIndex() {
  return (
    <main className="mx-auto max-w-2xl p-8 font-sans text-[#0c0e12]">
      <h1 className="text-2xl font-semibold">Call states</h1>
      <ol className="mt-6 grid gap-1 text-sm">
        {CALL_STATES.map((candidate) => (
          <li key={candidate.id}>
            <a className="underline" href={`?state=${candidate.id}`}>
              {candidate.title}
            </a>
          </li>
        ))}
      </ol>
    </main>
  );
}
