import { useState, type ReactNode } from "react";
import type { LinkQuality } from "@q9labsai/chalk-client";
import type { Action, CallState } from "./states";
import { Live } from "./live";
import { HOST, PEOPLE, liveSnapshot, type CallStateClient, type LiveOptions, type Person } from "./fixtures";

const nora: Person = PEOPLE[0]!;
const akash: Person = PEOPLE[1]!;
const crowd = (count: number, tweak: (person: Person, index: number) => Person): Person[] => Array.from({ length: count }, (_, index) => tweak({ ...PEOPLE[index % PEOPLE.length]!, id: `p${index}` }, index));

const openDetails: Action = { click: "Open connection details" };
const wait = (ms: number): Action => ({ wait: ms });

/** The harness pretends the device lost its network, which is what the card's offline copy reacts to. */
function OfflineDevice({ children }: { readonly children: ReactNode }) {
  useState(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
  return children;
}

type Spec = { readonly id: string; readonly title: string; readonly options: LiveOptions; readonly actions?: readonly Action[]; readonly then?: (client: CallStateClient) => void; readonly offline?: boolean };

/** Every state ships in dark and light, so the captures pair up. */
const both = ({ id, title, options, actions, then, offline }: Spec): CallState[] =>
  (["dark", "light"] as const).map((scheme) => ({
    id: scheme === "dark" ? id : `${id}-light`,
    title: scheme === "dark" ? title : `${title}, Light`,
    ...(actions ? { actions } : {}),
    render: () => {
      const call = <Live snapshot={liveSnapshot(options)} initialColorScheme={scheme} then={then} />;
      return offline ? <OfflineDevice>{call}</OfflineDevice> : call;
    },
  }));

const link = (tier: LinkQuality["tier"], reason?: LinkQuality["reason"]): LinkQuality => ({ tier, ...(reason ? { reason } : {}) });
const backLive = (client: CallStateClient, after: number) => {
  setTimeout(() => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live", lastError: null } })), after);
};

export const CONNECTION_STATES: readonly CallState[] = [
  ...both({ id: "conn-weak-loss", title: "Weak connection: loss", options: { others: [nora, akash], network: "unstable", link: link("weak", "loss") } }),
  ...both({ id: "conn-weak-latency", title: "Weak connection: latency", options: { others: [nora, akash], network: "unstable", link: link("weak", "latency") } }),
  ...both({ id: "conn-weak-sync", title: "Weak connection: slow chat and reactions", options: { others: [nora, akash], link: link("weak", "sync") } }),
  ...both({ id: "conn-weak-details", title: "Weak connection: chip opens the call menu", options: { others: [nora, akash], network: "unstable", link: link("weak", "loss") }, actions: [openDetails] }),
  ...both({ id: "conn-poor-video-on", title: "Very poor connection, video on", options: { others: [nora, akash], network: "unstable", link: link("poor", "loss") } }),
  ...both({ id: "conn-poor-video-off", title: "Very poor connection, video off", options: { self: { camera: false }, others: [nora, akash], network: "unstable", link: link("poor", "loss") } }),
  ...both({
    id: "conn-guest-weak",
    title: "A guest's weak and very poor connection on tiles",
    options: { others: [{ ...nora, quality: "weak" }, { ...akash, quality: "poor" }, ...PEOPLE.slice(2, 4)] },
  }),
  ...both({
    id: "conn-guest-small",
    title: "Weak connection on small tiles: bars only",
    options: { others: crowd(9, (person, index) => (index === 1 ? { ...person, quality: "weak" } : index === 4 ? { ...person, quality: "poor" } : person)) },
  }),
  ...both({ id: "conn-reconnecting", title: "Reconnecting, after 4 seconds", options: { others: [nora, akash], status: "reconnecting" }, actions: [wait(2_700)] }),
  ...both({ id: "conn-reconnecting-long", title: "Still reconnecting, after 20 seconds", options: { others: [nora, akash], status: "reconnecting" }, actions: [wait(20_500)] }),
  ...both({ id: "conn-offline", title: "Offline with unsent actions", options: { others: [nora, akash], status: "reconnecting", offlinePending: true }, actions: [wait(2_700)], offline: true }),
  ...both({ id: "conn-recovered", title: "Back in the call", options: { others: [nora, akash], status: "reconnecting" }, then: (client) => backLive(client, 2_500), actions: [wait(1_700)] }),
  ...both({
    id: "conn-failed",
    title: "Connection lost: the call stays, dimmed, with a way back",
    options: { others: [nora, akash] },
    then: (client) => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "failed", lastError: { code: "connection.sync_recovery_exhausted", recoverable: false, message: "Chalk could not reconnect to this Space." } } })),
  }),
  ...both({ id: "conn-guest-reconnecting", title: "A guest is reconnecting", options: { others: [{ ...nora, reconnecting: true }, akash] }, actions: [wait(2_700)] }),
  ...both({
    id: "conn-guest-reconnecting-small",
    title: "Guests reconnecting on small tiles: ring only",
    options: { others: crowd(9, (person, index) => (index === 2 ? { ...person, reconnecting: true } : person)), capabilities: HOST },
    actions: [wait(2_700)],
  }),
];
