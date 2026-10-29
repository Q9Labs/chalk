// Browser setup can outlast the empty-Episode linger. Only getAccess may create it.
export function createIntegratorSession({ createEpisode, admit, refresh }) {
  const guests = [1, 2].map((id) => ({ id, ready: false, admission: null, queue: Promise.resolve() }));
  let episodePromise;
  const guestFor = (id) => {
    const guest = guests.find((entry) => entry.id === id);
    if (!guest) throw new Error("Unknown integrator guest");
    return guest;
  };
  return {
    markReady(id) {
      guestFor(id).ready = true;
    },
    get ready() {
      return guests.every((guest) => guest.ready);
    },
    async getAccess(id, request) {
      const guest = guestFor(id);
      if (!guests.every((entry) => entry.ready)) {
        throw Object.assign(new Error("Prepare both integrator clients before Join"), { status: 409 });
      }
      const next = guest.queue.then(async () => {
        // Cache the promise before awaiting it: simultaneous Joins share one Episode.
        const episode = await (episodePromise ??= Promise.resolve().then(createEpisode));
        if (!guest.admission) {
          guest.admission = await admit(episode, id);
        } else {
          guest.admission.access = await refresh(episode, guest.admission, request);
        }
        return guest.admission.access;
      });
      guest.queue = next.catch(() => {}); // The HTTP caller receives the failure; later refreshes can retry.
      return next;
    },
  };
}
