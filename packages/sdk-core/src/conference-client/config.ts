import type { ConferenceClientConfig } from "../types.ts";
import { createAxiomWideEventsHandler } from "../wide-events/axiom.ts";
import { wideEvents } from "../wide-events/index.ts";

export const DEFAULT_API_URL = "https://api.chalk.dev";

export const deriveWsUrl = (apiUrl?: string): string => {
  if (!apiUrl) {
    throw new Error("apiUrl is required");
  }

  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    return url.toString();
  } catch {
    const wsProtocol = apiUrl.startsWith("https") ? "wss" : "ws";
    const baseUrl = apiUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `${wsProtocol}://${baseUrl}/ws`;
  }
};

export const isTokenExpired = (token: string): boolean => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return true;
    }

    const payloadB64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");

    let decoded: string;
    if (typeof atob === "function") {
      decoded = atob(payloadB64);
    } else if (typeof Buffer !== "undefined") {
      decoded = Buffer.from(payloadB64, "base64").toString("utf-8");
    } else {
      return false;
    }

    const payload = JSON.parse(decoded) as { exp: number };
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
};

export const configureConferenceWideEvents = (config: ConferenceClientConfig): void => {
  const userHandler = config.wideEvents?.handler;
  const axiomEnabled = config.axiom?.enabled ?? false;
  const axiomHandler = axiomEnabled
    ? createAxiomWideEventsHandler({
        token: config.axiom!.token,
        dataset: config.axiom!.dataset,
        endpoint: config.axiom!.endpoint,
        flushIntervalMs: config.axiom!.flushIntervalMs,
        maxBatchSize: config.axiom!.maxBatchSize,
        debug: config.axiom!.debug ?? config.debug ?? false,
      }).handler
    : undefined;

  const combinedHandler =
    userHandler && axiomHandler
      ? (event: any) => {
          userHandler(event);
          axiomHandler(event);
        }
      : (userHandler ?? axiomHandler);

  wideEvents.configure({
    enabled: config.wideEvents?.enabled ?? config.debug ?? false,
    handler: combinedHandler,
    includeDebugInfo: config.wideEvents?.includeDebugInfo ?? config.debug ?? false,
  });
};
