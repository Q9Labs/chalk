import { launchGuests } from "./media.mjs";
import { hearAfterUnmute, unheardAfterUnmute } from "./audio-decode.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { bounds, judgeOfferGrowth, judgeRepublishes, largest, offerSizes } from "./toggle-offers-criteria.mjs";
import { check, mediaPlane, save, waitFor } from "./runtime.mjs";

const guestCount = 3;
const calls = [
  { name: "in order", joinOrder: [0, 1, 2], rounds: bounds.rounds },
  { name: "in reverse", joinOrder: [2, 1, 0], rounds: bounds.reverseRounds },
];

/** The plan `pnpm prod:proof toggle-offers --dry-run` prints; it needs no configuration and opens no connection. */
export function toggleOffersPlan() {
  return [
    `Toggle offers: ${calls.length} calls of ${guestCount} guests on ${mediaPlane}, each in its own Space`,
    ...calls.map(
      (call) => `Call joining ${call.name} (guests ${call.joinOrder.map((guest) => guest + 1).join(", ")}): ${call.rounds} rounds (${call.rounds - 1} growth-check rounds after round 1 establishes the live-track baseline); each round every guest turns its microphone and camera off and on`,
    ),
    `Round 1's largest offer is the baseline; join-time offer sizes are informational. Fails when a later round's final offer exceeds that baseline by more than ${bounds.growthBytes} bytes, or when any offer passes ${bounds.nodeLimitBytes} bytes,`,
    `or when a listener does not hear a re-published microphone within the unmute window (at least ${bounds.minRepublishes} re-publishes per guest and call). Prints toggle count against offer size.`,
  ].join("\n");
}

const setMicrophone = (page, enabled) => page.evaluate((value) => window.proofClient.media.setMicrophoneEnabled(value), enabled);
const setCamera = (page, enabled) => page.evaluate((value) => window.proofClient.media.setCameraEnabled(value), enabled);

/** True while the guest holds a live remote camera and microphone of every other participant. */
const hearsAndSeesAll = (page, others) =>
  page.evaluate((ids) => {
    const remote = window.proofClient.getSnapshot().media.remote;
    return ids.every((id) => ["microphone", "camera"].every((source) => remote.some((entry) => entry.participantId === id && entry.source === source && entry.track.readyState === "live")));
  }, others);

async function joinInOrder(run, space, guests, order) {
  for (const guest of order) {
    await guests.pages[guest].evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: run.config.api_url, name: `Proof guest ${guest + 1}` });
  }
  await waitFor(`${guestCount} guests live with each other's tracks`, async () => {
    for (const [guest, page] of guests.pages.entries()) {
      if (
        !(await hearsAndSeesAll(
          page,
          guests.participants.filter((_, other) => other !== guest),
        ))
      )
        return false;
    }
    return true;
  });
}

/** One call: join in the given order, then `rounds` rounds of every guest turning its microphone and camera off and on. */
async function toggleCall(run, receiver, call) {
  const space = await createSpace(run, mediaPlane);
  const { episode, end } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log(`Call joining ${call.name}: ${guestCount} guests on ${mediaPlane}`);
  const guests = await launchGuests(run, space, episode, "", receiver.origin, true, guestCount, { deferJoin: true });
  try {
    await joinInOrder(run, space, guests, call.joinOrder);
    await run.wait(3000); // The last offers of the join are sent.
    const cursors = guests.networks.map((network) => network.length);
    const joinBaseline = guests.networks.map((network) => largest(offerSizes(network), NaN));
    const finals = [...joinBaseline];
    const rounds = [];
    const hearings = [];
    const failures = [];
    for (let round = 1; round <= call.rounds; round++) {
      await Promise.all(
        guests.pages.map(async (page, guest) => {
          try {
            await setMicrophone(page, false);
            await setCamera(page, false);
          } catch (error) {
            failures.push(`Round ${round}: guest ${guest + 1} could not turn its tracks off: ${String(error.message).split("\n")[0]}`);
          }
        }),
      );
      await run.wait(300);
      const turnedOn = await Promise.all(
        guests.pages.map(async (page, guest) => {
          const turnedOnAt = Date.now();
          try {
            await setMicrophone(page, true);
            await setCamera(page, true);
            return { guest, turnedOnAt };
          } catch (error) {
            failures.push(`Round ${round}: guest ${guest + 1} could not turn its tracks on: ${String(error.message).split("\n")[0]}`);
            return null;
          }
        }),
      );
      const heard = await Promise.all(turnedOn.filter(Boolean).map(({ guest, turnedOnAt }) => hearAfterUnmute(guests, guest, { turnedOnAt }).then((verdicts) => ({ speaker: guest, round, verdicts }))));
      hearings.push(...heard);
      await waitFor(
        `round ${round}: every guest holds every other guest's microphone and camera`,
        async () => {
          for (const [guest, page] of guests.pages.entries())
            if (
              !(await hearsAndSeesAll(
                page,
                guests.participants.filter((_, other) => other !== guest),
              ))
            )
              return false;
          return true;
        },
        30_000,
        500,
      ).catch((error) => failures.push(String(error.message).split("\n")[0]));
      rounds.push(
        guests.networks.map((network, guest) => {
          const sizes = offerSizes(network, cursors[guest]);
          cursors[guest] = network.length;
          finals[guest] = sizes.at(-1) ?? finals[guest];
          return { largest: largest(sizes, finals[guest]), final: finals[guest] };
        }),
      );
      if (round % 10 === 0)
        console.log(
          `  round ${round}: largest/final offer ${rounds
            .at(-1)
            .map((entry) => `${entry.largest}/${entry.final}`)
            .join(", ")} bytes`,
        );
    }
    const growth = judgeOfferGrowth({ joinBaseline, rounds });
    console.log(`Toggle count against offer size after the round 1 baseline, call joining ${call.name} (bytes):`);
    for (const line of growth.table) console.log(`  ${line}`);
    failures.push(...growth.failures.map((failure) => `${call.name}: ${failure}`));
    failures.push(...judgeRepublishes({ hearings, guests: guestCount }).map((failure) => `${call.name}: ${failure}`));
    const evidence = { call: call.name, joinOrder: call.joinOrder, joinBaseline, baseline: growth.baseline, rounds, hearings: hearings.map(({ speaker, round, verdicts }) => ({ speaker, round, unheard: unheardAfterUnmute(speaker, verdicts) })), failures };
    await save(`${run.directory}/toggle-offers-${call.name.replace(" ", "-")}.json`, evidence);
    return failures;
  } finally {
    await end();
    for (const page of guests.pages) await page.context().close();
  }
}

export async function toggleOffersProof(run, receiver) {
  const failures = [];
  for (const call of calls) failures.push(...(await toggleCall(run, receiver, call)));
  for (const failure of failures) console.log(`Toggle offers failure: ${failure}`);
  check(!failures.length, failures.slice(0, 5).join("; "));
  return { calls: calls.length, failures: 0 };
}
