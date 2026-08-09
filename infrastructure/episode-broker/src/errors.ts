import { ChalkAPIError } from "@q9labsai/chalk-client/server";

import { BrokerError } from "./contracts";
import { json } from "./http";

const genericBrokerError = "The Episode broker could not complete the request.";

export function brokerErrorResponse(error: unknown): Response {
  if (error instanceof BrokerError) return json(error.status, { error: error.message }, error.headers);
  if (error instanceof ChalkAPIError) {
    const status = upstreamStatus(error.status);
    return json(status, { error: upstreamMessage(status) });
  }
  return json(502, { error: genericBrokerError });
}

function upstreamStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function upstreamMessage(status: number): string {
  switch (status) {
    case 401:
      return "The Participant credential is missing or expired.";
    case 403:
      return "Access to the Episode was denied.";
    case 404:
      return "The Episode was not found.";
    case 409:
      return "The Episode could not be created.";
    case 429:
      return "Too many Episode requests. Try again shortly.";
    case 503:
      return "The Episode service is unavailable.";
    default:
      return genericBrokerError;
  }
}
