// Preserve the admission error union published in 5.1.0. This new wire code uses
// the client's existing HttpClientError response channel until the next major.
export function publicErrorCodes(operationId, response) {
  return (response["x-chalk-error-codes"] ?? []).filter((code) => operationId !== "admitEpisodeParticipant" || code !== "participant.not_active");
}
