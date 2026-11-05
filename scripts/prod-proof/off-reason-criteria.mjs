const matches = (item, expected) => Boolean(item) && Object.entries(expected).every(([name, value]) => item[name] === value);
const samples = (side) => [side.stopped, side.reopened];
const hostWire = (item) => matches(item, { enabled: false, publication_id: null, off_reason: "host" }) && Number.isInteger(item.off_revision);
const plainWire = (item) => matches(item, { enabled: false, publication_id: null }) && !("off_reason" in item) && !("off_revision" in item);
const hostDecoded = ({ decoded, wire }) => matches(decoded, { enabled: false, offReason: "host", offRevision: wire?.off_revision }) && Number.isInteger(decoded.offRevision);
const plainDecoded = ({ decoded }) => matches(decoded, { enabled: false, offReason: undefined, offRevision: undefined });
const staysOpen = (side) => samples(side).every((sample) => sample.live === true && sample.unexpectedCloses === 0);

// Each row is [check name, predicate over one side's observation].
const sideChecks = {
  candidate: [
    ["WelcomeOffersExtension", (side) => matches(side.welcome, { media_off_reason: true }) && side.negotiated === true],
    ["ConnectionStaysOpen", staysOpen],
    ["SeesHostStop", (side) => hostWire(side.stopped.wire)],
    ["ReopenKeepsHostStop", (side) => hostWire(side.reopened.wire) && side.reopened.wire.off_revision === side.stopped.wire?.off_revision],
    ["SdkKeepsHostStop", (side) => samples(side).every(hostDecoded)],
  ],
  baseline: [
    ["WelcomeUnchanged", (side) => Boolean(side.welcome) && !("media_off_reason" in side.welcome)],
    ["ConnectionStaysOpen", staysOpen],
    ["SeesStopWithoutReason", (side) => plainWire(side.stopped.wire)],
    ["ReopenStaysOffWithoutReason", (side) => plainWire(side.reopened.wire)],
    ["SdkStateHasNoReason", (side) => samples(side).every(plainDecoded)],
  ],
};

export function evaluateOffReason(observed) {
  const checks = {};
  for (const [name, rows] of Object.entries(sideChecks)) {
    const side = { stopped: {}, reopened: {}, ...observed[name] };
    for (const [check, test] of rows) checks[`${name}${check}`] = test(side);
  }
  return { passed: Object.values(checks).every(Boolean), checks };
}
