import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ChalkApi } from "./generated/http-api";
import { journeyHeaders, type JourneyTelemetryContext } from "./telemetry";

export type ChalkBearerAuth = {
  readonly type: "bearer";
  readonly token: string;
};

export type ChalkAuth = ChalkBearerAuth;

export type ChalkClientHeaders = Readonly<Record<string, string>>;

export type ChalkEffectClientOptions = {
  readonly baseUrl: string | URL;
  readonly auth?: ChalkAuth;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: ChalkClientHeaders;
  /** Optional v1 journey context. Generated API calls receive lowercase x-chalk-journey-id and W3C trace headers. */
  readonly telemetry?: JourneyTelemetryContext;
};

export const createChalkEffectClient = (options: ChalkEffectClientOptions) => {
  const client = HttpApiClient.make(ChalkApi, {
    baseUrl: options.baseUrl,
    transformClient: (client) =>
      HttpClient.mapRequest(client, (request) => {
        const headers = requestHeaders(options);
        return Object.keys(headers).length === 0 ? request : HttpClientRequest.setHeaders(request, headers);
      }),
  }).pipe(Effect.provide(FetchHttpClient.layer));

  return options.fetch ? client.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch)) : client;
};

function requestHeaders(options: ChalkEffectClientOptions): Record<string, string> {
  return {
    ...options.headers,
    ...(options.telemetry ? journeyHeaders(options.telemetry) : {}),
    ...authHeaders(options.auth),
  };
}

function authHeaders(auth: ChalkAuth | undefined): Record<string, string> {
  if (!auth) {
    return {};
  }

  switch (auth.type) {
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
  }
}
