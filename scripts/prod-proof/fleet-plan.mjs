// The plan of a canary call, apart from the browsers that carry it out.

// A small seeded generator, so a run's plan can be repeated.
export function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The plan of one call: size, length and the actions it takes in a shuffled order. */
export function planCall(random, options, id, recording) {
  const whole = ([low, high]) => low + Math.floor(random() * (high - low + 1));
  const guests = whole(options.guests);
  const actions = [{ kind: "microphone", guest: whole([0, guests - 1]) }];
  if (random() < 0.7) actions.push({ kind: "camera", guest: whole([0, guests - 1]) });
  if (random() < options.screenFraction) actions.push({ kind: "screen", guest: whole([0, guests - 1]) });
  // Guest 1 ends the Episode through the SDK, so it keeps its browser.
  if (random() < options.rejoinFraction) actions.push({ kind: "rejoin", guest: whole([1, guests - 1]) });
  for (let index = actions.length - 1; index > 0; index--) {
    const other = whole([0, index]);
    [actions[index], actions[other]] = [actions[other], actions[index]];
  }
  return { id, guests, holdSeconds: whole(options.callSeconds), actions, muteHold: random() < 0.5 ? whole([0, guests - 1]) : undefined, recording };
}

// The script alternates holds and actions, then optionally mutes one guest before the last hold.
export function scriptOf(spec) {
  const slice = spec.holdSeconds / (spec.actions.length + 1);
  const mute = spec.muteHold === undefined ? [] : [{ mute: spec.muteHold }];
  return [...spec.actions.flatMap((action) => [{ hold: slice }, { action }]), ...mute, { hold: slice }];
}
