import "../lib/camera-effects";
import { installWhiteboardAssets } from "../lib/whiteboard-assets";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { installFakeDevices } from "./media";
import type { CallState, CallStateMeta } from "./states";

installWhiteboardAssets();

declare global {
  interface Window {
    __CALL_STATES__?: readonly CallStateMeta[];
  }
}

export function mountCallStates(states: readonly CallState[]): void {
  window.__CALL_STATES__ = states.map(({ render: _render, ...meta }) => meta);
  const params = new URLSearchParams(location.search);
  const id = params.get("state");
  const state = states.find((candidate) => candidate.id === id);
  if (!params.has("browserMedia")) installFakeDevices({ blocked: state?.cameraBlocked === true });

  const root = document.getElementById("root");
  if (!root) throw new Error("Call fixture has no #root element.");
  // No StrictMode: its doubled effects in development change what the board shows while it loads.
  createRoot(root).render(state ? state.render() : <StateIndex states={states} />);
}

function StateIndex({ states }: { readonly states: readonly CallState[] }) {
  return (
    <main className="mx-auto max-w-2xl p-8 font-sans text-(--ink)">
      <h1 className="text-2xl font-semibold">Call states</h1>
      <ol className="mt-6 grid gap-1 text-sm">
        {states.map((candidate) => (
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
