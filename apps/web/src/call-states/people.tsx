import { useEffect, useState } from "react";
import { CallLimbo, Chalk } from "@q9labsai/chalk-react";
import type { CallState } from "./states";
import { HOST, PEOPLE, SELF_NAME, SPACE_NAME, createCallStateClient, liveSnapshot, type Person } from "./fixtures";

type Scheme = "dark" | "light";

const [nora, akash, sofia, malik, priya, eli, june, tomas, lena, kenji, amara, omar] = PEOPLE as readonly [Person, Person, Person, Person, Person, Person, Person, Person, Person, Person, Person, Person];

const SMALL: readonly Person[] = [
  { ...nora, speaking: true },
  { ...akash, handRaised: true },
  { ...sofia, microphone: false, camera: false },
];
const SMALL_WITH_AGENT: readonly Person[] = [SMALL[0]!, { ...SMALL[1]!, agent: true, description: "AI teammate" }, SMALL[2]!];
const BIG: readonly Person[] = [
  { ...nora, host: true, speaking: true },
  { ...akash, handRaised: true, sharing: true },
  { ...sofia, microphone: false, camera: false },
  { ...malik, microphone: false },
  { ...priya, handRaised: true },
  { ...eli, reconnecting: true, microphone: false },
  june,
  { ...tomas, camera: false },
  lena,
  kenji,
  amara,
  omar,
];

function PeopleState({ scheme, others, host = true, knocks = 0 }: { readonly scheme: Scheme; readonly others: readonly Person[]; readonly host?: boolean; readonly knocks?: number }) {
  const [client] = useState(() => createCallStateClient(liveSnapshot({ others, ...(host ? { capabilities: HOST, admission: knocks } : {}) })));
  useEffect(() => () => client.dispose(), [client]);
  return (
    <main className="h-dvh">
      <Chalk client={client} displayName={SELF_NAME} spaceName={SPACE_NAME} theme={{ colorScheme: scheme }} />
    </main>
  );
}

const variants = [
  { id: "small", title: "People: small call", others: SMALL, panel: true },
  { id: "agent", title: "People: agent participant", others: SMALL_WITH_AGENT, panel: true },
  { id: "big", title: "People: big call", others: BIG, panel: true },
  { id: "search", title: "People: search", others: BIG, panel: true },
  { id: "menu", title: "People: host row menu", others: BIG, panel: true },
  { id: "menu-muted", title: "People: host row menu, muted person", others: BIG, panel: true },
  { id: "confirm", title: "People: remove confirm", others: BIG, panel: true },
  { id: "guest", title: "People: guest view", others: BIG, panel: true, host: false },
  { id: "call-menu", title: "Call menu: host", others: SMALL, clicks: ["Call details"] },
  { id: "call-menu-mute", title: "Call menu: host, mute everyone confirm", others: SMALL, clicks: ["Call details", "Mute everyone"] },
  { id: "call-menu-guest", title: "Call menu: guest view", others: SMALL, host: false, clicks: ["Call details"] },
  { id: "wait-one", title: "Waiting room: one knock", others: SMALL, knocks: 1 },
  { id: "wait-several", title: "Waiting room: several knocks", others: SMALL, knocks: 3 },
  { id: "wait-list", title: "Waiting room: host list", others: SMALL, knocks: 3, panel: true },
] as const;

export const PEOPLE_STATES: readonly CallState[] = (["dark", "light"] as const).flatMap((scheme) =>
  variants.map((variant): CallState => {
    const panel = "panel" in variant && variant.panel;
    return {
      id: `people-${variant.id}-${scheme}`,
      title: `${variant.title} (${scheme})`,
      actions: panel ? [{ click: "People" }] : "clicks" in variant ? variant.clicks.map((click) => ({ click })) : undefined,
      render: () => <PeopleState scheme={scheme} others={variant.others} host={"host" in variant ? variant.host : true} knocks={"knocks" in variant ? variant.knocks : 0} />,
    };
  }),
);

const guestScreens = {
  waiting: (scheme: Scheme) => <CallLimbo theme={{ colorScheme: scheme }} spaceName={SPACE_NAME} message={`Asking to join ${SPACE_NAME}`} detail="The host will let you in." joiningAs="Rania Aziz" action={{ label: "Cancel", onClick: () => undefined }} />,
  declined: (scheme: Scheme) => <CallLimbo theme={{ colorScheme: scheme }} spaceName={SPACE_NAME} message="The host didn’t let you in" glyph="declined" action={{ label: "Go to Chalk", onClick: () => undefined }} secondaryAction={{ label: "Ask again", onClick: () => undefined }} />,
  expired: (scheme: Scheme) => (
    <CallLimbo theme={{ colorScheme: scheme }} spaceName={SPACE_NAME} message="Your request to join expired or is no longer available." glyph="expired" action={{ label: "Go to Chalk", onClick: () => undefined }} secondaryAction={{ label: "Ask again", onClick: () => undefined }} />
  ),
  entering: (scheme: Scheme) => <CallLimbo theme={{ colorScheme: scheme }} spaceName={SPACE_NAME} message={`Joining ${SPACE_NAME}…`} />,
} as const;

export const PEOPLE_GUEST_STATES: readonly CallState[] = (["dark", "light"] as const).flatMap((scheme) =>
  (Object.keys(guestScreens) as (keyof typeof guestScreens)[]).map(
    (kind): CallState => ({
      id: `people-guest-${kind}-${scheme}`,
      title: `Waiting room: guest ${kind} (${scheme})`,
      render: () => <main className="h-dvh">{guestScreens[kind](scheme)}</main>,
    }),
  ),
);
