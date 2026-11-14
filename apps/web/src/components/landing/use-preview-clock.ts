import { useEffect, useState } from "react";

import type { CallPerson } from "./PreviewStage";

const JOINERS = { team: ["Malik Haddad", "Nora Patel"], class: ["June Park", "Omar Farouk"] } as const;

/** The next person after `current` who is neither you nor muted, or `current` when there is none. */
function nextSpeaker(people: readonly CallPerson[], current: number): number {
  for (let offset = 1; offset <= people.length; offset++) {
    const next = (current + offset) % people.length;
    const person = people[next];
    if (person && !person.you && !person.muted) return next;
  }
  return current;
}

/** The preview call's clock, its rotating speaker and its "joined" toast. It stops when the call is still or left, and the speaker and toast hold under reduced motion. */
export function usePreviewClock({ people, team, run }: { readonly people: readonly CallPerson[]; readonly team: boolean; readonly run: boolean }) {
  const [seconds, setSeconds] = useState(521);
  const [speaker, setSpeaker] = useState(0);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!run) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const joiners = JOINERS[team ? "team" : "class"];
    let tick = 0;
    const interval = window.setInterval(() => {
      setSeconds((value) => value + 1);
      tick++;
      if (reduced.matches) return;
      if (tick % 3 === 0) setSpeaker((value) => nextSpeaker(people, value));
      if (tick % 11 === 4) setToast(joiners[tick % 22 < 11 ? 0 : 1]);
      if (tick % 11 === 7) setToast("");
    }, 1000);
    return () => window.clearInterval(interval);
  }, [run, team, people]);
  return { seconds, speaker, toast, clearToast: () => setToast("") };
}
