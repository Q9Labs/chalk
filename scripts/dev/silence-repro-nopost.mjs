// Usage: node scripts/dev/silence-repro-nopost.mjs <silence-repro.json>...
// Lists every speaker unmute tap that was not followed by a local-track POST /media/sfu/tracks within 10 s, and what the SDK showed for that speaker.
// Network `at` and `clickedAtMs` are both milliseconds since the room's origin.
import { readFileSync } from "node:fs";

const windowMs = 10_000;
const rows = [];
let taps = 0;
for (const file of process.argv.slice(2)) {
  for (const run of JSON.parse(readFileSync(file, "utf8")).runs) {
    const network = run.network ?? [];
    const publishes = (speaker) => network.filter((entry) => entry.participant === speaker && entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks") && String(entry.locations).includes("local"));
    for (const action of run.actions ?? []) {
      if (action.kind !== "unmute") continue;
      taps++;
      const tap = action.clickedAtMs;
      const mine = publishes(action.participant);
      if (mine.some((entry) => entry.at >= tap && entry.at <= tap + windowMs)) continue;
      const near = network.filter((entry) => entry.participant === action.participant && entry.at >= tap - 5000 && entry.at <= tap + windowMs && entry.path.endsWith("/media/sfu/renegotiate"));
      const samples = (run.samples ?? []).map((sample) => sample.states.find((state) => state.listener === action.participant)).filter(Boolean);
      const last = samples.at(-1);
      const afterTap = (run.samples ?? [])
        .filter((sample) => sample.atMs >= tap)
        .map((sample) => sample.states.find((state) => state.listener === action.participant))
        .filter(Boolean);
      const errors = afterTap.flatMap((state) => state.errors ?? []).map((error) => `${error.kind}:${error.message}`);
      const commandErrors = [
        ...new Set(
          afterTap
            .map((state) => state.commandError)
            .filter(Boolean)
            .map((error) => `${error.code}`),
        ),
      ];
      rows.push({
        build: run.build,
        condition: run.condition,
        invocation: run.invocation,
        runIndex: run.runIndex,
        speaker: action.participant,
        tapT: Number(action.t.toFixed(1)),
        first: action.first,
        earlierPublication: mine.some((entry) => entry.at < tap),
        inFlightRenegotiate: near.length,
        micAtEnd: last?.mic ?? null,
        micDetailAtEnd: last?.micDetail ?? null,
        statusAtEnd: last?.status ?? null,
        commandErrors,
        sdkErrors: [...new Set(errors)],
      });
    }
  }
}
console.log(`unmute taps ${taps}, without a local POST tracks within ${windowMs / 1000} s: ${rows.length}`);
for (const row of rows) console.log(JSON.stringify(row));
