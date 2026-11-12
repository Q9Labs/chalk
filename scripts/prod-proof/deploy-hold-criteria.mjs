// What a Participant must not see while a deploy runs under a live call: a rejoin, a media gap, a lost chat message.
export const bounds = {
  /** A guest may be off `live` for no sample: a socket loss the SDK hides never leaves `live`. */
  notLiveMs: 0,
  /** Received or sent media may stand still this long. The own SFU keeps relaying while the API restarts. */
  mediaGapMs: 3000,
  /** A chat message sent during the deploy must reach every other guest within this long. */
  chatLateMs: 10_000,
};

const seconds = (ms) => Math.round(ms / 100) / 10;

/** Longest stretch, in ms, of consecutive ticks for which `bad(tick)` is true; a stretch of one tick lasts one interval. */
function longest(ticks, bad, intervalMs) {
  let best = 0;
  let from = null;
  for (const [index, tick] of ticks.entries()) {
    if (!bad(tick, index)) {
      from = null;
      continue;
    }
    from ??= tick.t;
    best = Math.max(best, tick.t - from + intervalMs);
  }
  return best;
}

const received = (sample) => sample.remotes.reduce((total, remote) => total + remote.bytes, 0);

/**
 * @param ticks `{ t, guests: [sample] }` every `intervalMs`; a sample is `{ reachable, status, participantId, outAudio, remotes: [{ bytes }] }`.
 * @param sent Chat sends by guest 1: `{ text, sentAt, ok }`.
 * @param delivered For each other guest, `Map<text, firstSeenAt>`.
 * @param deploy `{ startedAt, endedAt }` of the deploy command.
 */
export function judgeDeployHold({ ticks, sent, delivered, deploy, intervalMs }) {
  const failures = [];
  const first = ticks[0].guests;
  const last = ticks.at(-1).guests;
  const perGuest = first.map((_, guest) => {
    const own = ticks.map((tick) => ({ t: tick.t, ...tick.guests[guest] }));
    return {
      guest: guest + 1,
      rejoined: own.some((sample) => sample.participantId !== first[guest].participantId),
      notLiveMs: longest(own, (sample) => !sample.reachable || sample.status !== "live", intervalMs),
      inboundGapMs: longest(own, (sample, index) => index > 0 && received(sample) <= received(own[index - 1]), intervalMs),
      outboundGapMs: longest(own, (sample, index) => index > 0 && sample.outAudio <= own[index - 1].outAudio, intervalMs),
    };
  });
  for (const row of perGuest) {
    if (row.rejoined) failures.push(`guest ${row.guest} rejoined: its participant changed`);
    if (row.notLiveMs > bounds.notLiveMs) failures.push(`guest ${row.guest} was off live for ${seconds(row.notLiveMs)}s`);
    if (row.inboundGapMs > bounds.mediaGapMs) failures.push(`guest ${row.guest} received no media for ${seconds(row.inboundGapMs)}s`);
    if (row.guest === 1 && row.outboundGapMs > bounds.mediaGapMs) failures.push(`guest 1 sent no audio for ${seconds(row.outboundGapMs)}s`);
  }
  const accepted = sent.filter((message) => message.ok);
  const refused = sent.length - accepted.length;
  if (refused) failures.push(`${refused} chat send(s) failed`);
  const lost = [];
  let slowest = 0;
  for (const [index, seen] of delivered.entries()) {
    for (const message of accepted) {
      const at = seen.get(message.text);
      if (at === undefined) lost.push({ guest: index + 2, text: message.text });
      else slowest = Math.max(slowest, at - message.sentAt);
    }
  }
  if (lost.length) failures.push(`${lost.length} chat message(s) never arrived, first ${lost[0].text} at guest ${lost[0].guest}`);
  if (slowest > bounds.chatLateMs) failures.push(`a chat message took ${seconds(slowest)}s to arrive`);
  const evidence = {
    deploySeconds: seconds(deploy.endedAt - deploy.startedAt),
    guests: perGuest.map(({ guest, rejoined, notLiveMs, inboundGapMs, outboundGapMs }) => ({ guest, rejoined, notLiveSeconds: seconds(notLiveMs), inboundGapSeconds: seconds(inboundGapMs), outboundGapSeconds: seconds(outboundGapMs) })),
    chat: { sent: sent.length, accepted: accepted.length, lost: lost.length, slowestSeconds: seconds(slowest) },
    finalParticipants: last.map((sample) => sample.participantId),
  };
  return { failures, evidence };
}
