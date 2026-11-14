import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, type HttpApi, type HttpApiGroup } from "effect/unstable/httpapi";
import { withRequestContext } from "./session";
export type ChalkBearerAuth = {
  readonly type: "bearer";
  readonly token: string;
};
export type ChalkAuth = ChalkBearerAuth;
export type ChalkClientHeaders = Readonly<Record<string, string>>;
export type ChalkEffectClientOptions = {
  readonly baseUrl: string | URL;
  readonly auth?: ChalkAuth;
  /** Default fetch credentials mode for browser and edge requests. */
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: ChalkClientHeaders;
};
/** Shared by the full client and the public-invite client, which passes the smaller public API. */
export const makeChalkEffectClient = <Id extends string, Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<Id, Groups>, options: ChalkEffectClientOptions) => {
  return HttpApiClient.make(api, {
    baseUrl: options.baseUrl,
    transformClient: (client) =>
      HttpClient.mapRequest(client, (request) => {
        const headers = requestHeaders(options);
        return Object.keys(headers).length === 0 ? request : HttpClientRequest.setHeaders(request, headers);
      }),
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    // An empty RequestInit is what the fetch client assumes when none is provided.
    Effect.provideService(FetchHttpClient.RequestInit, options.credentials === undefined ? {} : { credentials: options.credentials }),
    Effect.provideService(FetchHttpClient.Fetch, withRequestContext(options.fetch)),
  );
};
function requestHeaders({ headers, auth }: ChalkEffectClientOptions): Record<string, string> {
  return { ...headers, ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}) };
}
