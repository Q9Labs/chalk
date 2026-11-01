const hostStopped = (item) => item?.enabled === false && item.publication_id === null && item.off_reason === "host" && Number.isInteger(item.off_revision);
const plainOff = (item) => item?.enabled === false && item.publication_id === null && !("off_reason" in item) && !("off_revision" in item);

export function evaluateOffReason({ candidate, baseline }) {
  const checks = {
    candidateWelcomeOffersExtension: candidate.welcome?.media_off_reason === true && candidate.negotiated === true,
    baselineWelcomeUnchanged: baseline.welcome !== undefined && !("media_off_reason" in baseline.welcome) && baseline.live === true && baseline.unexpectedCloses === 0,
    candidateSeesHostStop: hostStopped(candidate.stopped),
    baselineSeesStopWithoutReason: plainOff(baseline.stopped),
    candidateReopenKeepsHostStop: hostStopped(candidate.reopened) && candidate.reopened.off_revision === candidate.stopped?.off_revision,
    baselineReopenStaysOffWithoutReason: plainOff(baseline.reopened) && baseline.reopenedUnexpectedCloses === 0,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
