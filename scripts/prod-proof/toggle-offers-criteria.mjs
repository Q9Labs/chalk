// What the toggle-offers proof asks of a call: toggling the microphone and camera again and again must not grow the offers a
// client sends, and every re-published microphone must be heard. The node reuses the section of a closed track, so the size of an
// offer follows the live tracks and not the number of toggles. The numbers live here and the proof only measures.

export const bounds = {
  rounds: 50, // microphone and camera off and on again, by every guest
  reverseRounds: 8, // the same in the call that joins in the other order; at least minRepublishes
  minRepublishes: 6, // microphone re-publishes of every guest, in each join order
  growthBytes: 4096, // the final offer may exceed the offer at the first join by this much; one closed video section is 4.5 KB, so a leak of one shows
  nodeLimitBytes: 64 * 1024, // the node's cap on an offer; a client past it cannot negotiate
};

/** The sizes of the offers a guest sent (signaling-request records with an SDP of type offer) from record `from` on. */
export function offerSizes(network, from = 0) {
  return network
    .slice(from)
    .filter((row) => row.type === "signaling-request" && row.sdpType === "offer")
    .map((row) => row.sdpBytes);
}

/** The largest of `sizes`, or the `fallback` when the guest sent no offer (a toggle that needed none). */
export const largest = (sizes, fallback) => (sizes.length ? Math.max(...sizes) : fallback);

/**
 * `baseline` is each guest's largest offer up to the end of the join. `rounds` is one entry per round, each with one `{ largest, final }` per guest,
 * where `final` is the last offer the guest sent in the round (carried over from the round before when it sent none).
 * @returns { failures, table } the failures name the guest and the sizes; the table is the log's toggle count against offer size.
 */
export function judgeOfferGrowth({ baseline, rounds }, limits = bounds) {
  const failures = [];
  baseline.forEach((size, guest) => {
    if (!Number.isFinite(size)) failures.push(`Guest ${guest + 1} sent no offer while joining, so there is no size to compare`);
  });
  if (!rounds.length) failures.push("No toggle round ran");
  rounds.forEach((round, index) => {
    round.forEach((entry, guest) => {
      if (entry.largest > limits.nodeLimitBytes) failures.push(`Guest ${guest + 1} sent an offer of ${entry.largest} bytes in round ${index + 1}, over the node's ${limits.nodeLimitBytes}`);
    });
  });
  rounds.at(-1)?.forEach((entry, guest) => {
    if (entry.final > baseline[guest] + limits.growthBytes) failures.push(`Guest ${guest + 1}'s final offer is ${entry.final} bytes after ${rounds.length} rounds, ${entry.final - baseline[guest]} more than the ${baseline[guest]} bytes at the first join (allowed ${limits.growthBytes})`);
  });
  return { failures, table: offerTable({ baseline, rounds }) };
}

/** Toggle count against offer size: the first round, every tenth and the last. A reader checks this for growth. */
function offerTable({ baseline, rounds }) {
  const header = `round | ${baseline.map((size, guest) => `guest ${guest + 1} largest/final (first join ${size})`).join(" | ")}`;
  const shown = rounds.flatMap((round, index) => (index === 0 || (index + 1) % 10 === 0 || index === rounds.length - 1 ? [`${String(index + 1).padStart(5)} | ${round.map((entry) => `${entry.largest}/${entry.final}`).join(" | ")}`] : []));
  return [header, ...shown];
}

/** Every guest re-published its microphone at least `minRepublishes` times, and every listener heard each one. `hearings` hold the `hearAfterUnmute` verdicts. */
export function judgeRepublishes({ hearings, guests }, limits = bounds) {
  const failures = [];
  for (let speaker = 0; speaker < guests; speaker++) {
    const own = hearings.filter((hearing) => hearing.speaker === speaker);
    if (own.length < limits.minRepublishes) failures.push(`Guest ${speaker + 1} re-published its microphone ${own.length} times, fewer than ${limits.minRepublishes}`);
    for (const hearing of own) {
      if (hearing.verdicts.length !== guests - 1) failures.push(`Round ${hearing.round}: ${hearing.verdicts.length} listeners judged guest ${speaker + 1}, want ${guests - 1}`);
      for (const verdict of hearing.verdicts.filter((entry) => !entry.pass)) failures.push(`Round ${hearing.round}: guest ${verdict.listener} did not hear guest ${speaker + 1} after its unmute (${verdict.why ?? `${verdict.peakDb} dB at bin ${verdict.bin}, floor ${verdict.floorDb} dB`})`);
    }
  }
  return failures;
}
