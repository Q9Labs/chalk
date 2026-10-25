// Preserve published 5.x error unions. New wire codes use the client's existing
// HttpClientError response channel until the next major.
export function publicErrorCodes(operationId, response) {
  return (response["x-chalk-error-codes"] ?? []).filter((code) => {
    if (operationId === "admitEpisodeParticipant" && code === "participant.not_active") return false;
    if ((operationId === "createAPIKey" || operationId === "rotateAPIKey") && code === "api_key.invalid_expiry") return false;
    return true;
  });
}
