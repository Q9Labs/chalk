export interface ParticipantEventEmitter {
  on?: (eventName: string, fn: (payload?: unknown) => void) => void;
}

export interface RtkParticipantsApi extends ParticipantEventEmitter {
  toArray?: () => unknown[] | Iterable<unknown>;
  joined: ParticipantEventEmitter & {
    toArray?: () => unknown[] | Iterable<unknown>;
    values?: () => Iterable<unknown>;
    forEach?: (cb: (participant: unknown) => void) => void;
    [Symbol.iterator]?: () => Iterator<unknown>;
  };
}

const toParticipantArray = (source: unknown): unknown[] => {
  if (!source) {
    return [];
  }

  if (Array.isArray(source)) {
    return source;
  }

  if (typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
    try {
      return Array.from(source as Iterable<unknown>);
    } catch {
      return [];
    }
  }

  return [];
};

export const toRtkParticipantsApi = (participants: unknown): RtkParticipantsApi => {
  const participantsApi = participants as {
    toArray?: () => unknown[] | Iterable<unknown>;
    on?: (event: string, handler: (speaker: unknown) => void) => void;
    joined?: {
      on?: (eventName: string, fn: (payload?: unknown) => void) => void;
      toArray?: () => unknown[] | Iterable<unknown>;
      values?: () => Iterable<unknown>;
      forEach?: (cb: (participant: unknown) => void) => void;
      [Symbol.iterator]?: () => Iterator<unknown>;
    };
  };

  return {
    toArray: participantsApi.toArray,
    on: participantsApi.on,
    joined: participantsApi.joined ?? {},
  };
};

export const collectJoinedParticipants = (participantsApi: RtkParticipantsApi): unknown[] => {
  if (typeof participantsApi.toArray === "function") {
    try {
      const snapshot = toParticipantArray(participantsApi.toArray());
      if (snapshot.length > 0) {
        return snapshot;
      }
    } catch {
      // fall through
    }
  }

  if (typeof participantsApi.joined.toArray === "function") {
    try {
      const snapshot = toParticipantArray(participantsApi.joined.toArray());
      if (snapshot.length > 0) {
        return snapshot;
      }
    } catch {
      // fall through
    }
  }

  if (typeof participantsApi.joined[Symbol.iterator] === "function") {
    try {
      const snapshot = Array.from(participantsApi.joined as Iterable<unknown>);
      if (snapshot.length > 0) {
        return snapshot;
      }
    } catch {
      // fall through
    }
  }

  const participants: unknown[] = [];

  if (typeof participantsApi.joined.values === "function") {
    try {
      for (const participant of participantsApi.joined.values()) {
        participants.push(participant);
      }
      if (participants.length > 0) {
        return participants;
      }
    } catch {
      // fall through
    }
  }

  if (typeof participantsApi.joined.forEach === "function") {
    try {
      participantsApi.joined.forEach((participant) => participants.push(participant));
    } catch {
      // best effort
    }
  }

  return participants;
};

export const getParticipantEmitters = (participantsApi: RtkParticipantsApi): ParticipantEventEmitter[] => [participantsApi.joined, participantsApi];

export const onParticipantsEvent = (emitters: ParticipantEventEmitter[], event: string, handler: (payload?: unknown) => void): void => {
  const attached = new Set<unknown>();

  for (const emitter of emitters) {
    if (!emitter || typeof emitter.on !== "function" || attached.has(emitter)) {
      continue;
    }

    attached.add(emitter);
    try {
      emitter.on(event, handler);
    } catch {
      // unsupported by this RTK build
    }
  }
};
