import { createRoot } from "react-dom/client";
import "../styles.css";
import { installFakeDevices } from "./media";
import { PRE_JOIN_STATES } from "./pre-join";

declare global {
  interface Window {
    __CALL_STATES__?: readonly Omit<(typeof PRE_JOIN_STATES)[number], "render">[];
  }
}

window.__CALL_STATES__ = PRE_JOIN_STATES.map(({ render: _render, ...meta }) => meta);
const id = new URLSearchParams(location.search).get("state");
const state = PRE_JOIN_STATES.find((candidate) => candidate.id === id);
installFakeDevices({ blocked: false });

const root = document.getElementById("root");
if (!root) throw new Error("pre-join-states.html has no #root element.");
createRoot(root).render(
  state ? (
    state.render()
  ) : (
    <ol className="mx-auto grid max-w-2xl gap-1 p-8 text-sm">
      {PRE_JOIN_STATES.map((candidate) => (
        <li key={candidate.id}>
          <a className="underline" href={`?state=${candidate.id}`}>
            {candidate.title}
          </a>
        </li>
      ))}
    </ol>
  ),
);
