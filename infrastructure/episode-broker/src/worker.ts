import { BrokerError, brokerPath, browserCredentialCookie, episodeDeadlineSeconds, type DurableObjectStubLike, type WorkerEnv } from "./contracts";
import { accessGrantInput, accessInput, browserParticipantCredentialInput, cookieValue, credentialInput, emptyInput, json, participantCredentialInput, privateHeaders, randomCapability, readJSON, requireOrigin, requireTrustedCaller, traceContext } from "./http";

type Log = (event: string, fields: Readonly<Record<string, boolean | number | string>>) => void;

export async function handleBrokerRequest(request: Request, env: WorkerEnv, log: Log = structuredLog): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  let response: Response;
  try {
    response = await route(request, env, url);
  } catch (error) {
    const status = error instanceof BrokerError ? error.status : 502;
    const message = error instanceof BrokerError ? error.message : "The Episode broker could not complete the request.";
    const headers = error instanceof BrokerError ? error.headers : undefined;
    response = json(status, { error: message }, headers);
  }
  log("request_complete", { method: request.method, path: url.pathname, requestId, status: response.status });
  return response;
}

async function route(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (url.pathname === `${brokerPath}/health`) return health(request, env);
  if (!url.pathname.startsWith(`${brokerPath}/`)) throw new BrokerError(404, "Not found.");
  if (request.method !== "POST") throw new BrokerError(405, "Method not allowed.", { allow: "POST" });
  const body = await readJSON(request);
  const trace = traceContext(request);

  if (url.pathname === `${brokerPath}/participant-credentials` && request.headers.get("origin") !== null) {
    requireOrigin(request, env.CHALK_APP_ORIGIN);
    const input = browserParticipantCredentialInput(body);
    await enforceRateLimit(env.CREATE_RATE_LIMITER, await anonymousRateKey(request));
    const existingCredential = cookieValue(request.headers.get("cookie"));
    const resume = Boolean(input.spaceInviteToken && existingCredential?.spaceInviteToken === input.spaceInviteToken);
    const spaceInviteToken = input.spaceInviteToken ?? randomCapability();
    const participantCredentialId = resume ? existingCredential!.participantCredentialId : randomCapability();
    const stub = episodeLeaseStub(env, spaceInviteToken);
    const brokerResponse = await internalRequest(stub, "/participant-credentials", {
      action: resume ? "resume" : input.spaceInviteToken ? "join" : "create",
      participantCredentialId,
      displayName: input.displayName,
      trace,
    });
    if (!brokerResponse.ok) return brokerResponse;
    const responseBody = (await brokerResponse.json()) as Record<string, unknown>;
    return json(201, { ...responseBody, spaceInviteToken }, { "set-cookie": browserCredential(spaceInviteToken, participantCredentialId) });
  }

  if (url.pathname === `${brokerPath}/participant-credentials`) {
    requireTrustedCaller(request, env.CHALK_APP_ORIGIN);
    const input = participantCredentialInput(body);
    await enforceRateLimit(env.CREATE_RATE_LIMITER, await anonymousRateKey(request));
    const spaceInviteToken = input.spaceInviteToken ?? randomCapability();
    const participantCredentialId = input.participantCredentialId ?? randomCapability();
    const stub = episodeLeaseStub(env, spaceInviteToken);
    const brokerResponse = await internalRequest(stub, "/participant-credentials", {
      action: input.participantCredentialId ? "resume" : input.spaceInviteToken ? "join" : "create",
      participantCredentialId,
      displayName: input.displayName,
      trace,
    });
    if (!brokerResponse.ok) return brokerResponse;
    return json(201, { ...(await brokerResponse.json()), participantCredentialId, spaceInviteToken });
  }

  if (url.pathname === `${brokerPath}/access-grants` && request.headers.get("origin") === null) {
    const input = accessGrantInput(body);
    await enforceRateLimit(env.EPISODE_RATE_LIMITER, input.participantCredentialId);
    return internalRequest(episodeLeaseStub(env, input.spaceInviteToken), "/access-grants", {
      participantCredentialId: input.participantCredentialId,
      currentMediaToken: input.currentMediaToken,
      replaceMediaConnection: input.replaceMediaConnection,
      trace,
    });
  }

  if (url.pathname === `${brokerPath}/participant-credentials/cleanup` && request.headers.get("origin") === null) {
    requireTrustedCaller(request, env.CHALK_APP_ORIGIN);
    const input = credentialInput(body);
    await enforceRateLimit(env.EPISODE_RATE_LIMITER, input.participantCredentialId);
    return internalRequest(episodeLeaseStub(env, input.spaceInviteToken), "/participant-credentials/cleanup", { participantCredentialId: input.participantCredentialId, trace });
  }

  requireOrigin(request, env.CHALK_APP_ORIGIN);
  const credential = cookieValue(request.headers.get("cookie"));
  if (!credential) throw new BrokerError(401, "The browser credential is missing or expired.");
  await enforceRateLimit(env.EPISODE_RATE_LIMITER, credential.participantCredentialId);
  const stub = episodeLeaseStub(env, credential.spaceInviteToken);

  if (url.pathname === `${brokerPath}/access-grants`) {
    const input = accessInput(body);
    return internalRequest(stub, "/access-grants", { ...input, participantCredentialId: credential.participantCredentialId, trace });
  }
  if (url.pathname === `${brokerPath}/participant-credentials/cleanup`) {
    emptyInput(body);
    const brokerResponse = await internalRequest(stub, "/participant-credentials/cleanup", { participantCredentialId: credential.participantCredentialId, trace });
    const headers = new Headers(brokerResponse.headers);
    if (brokerResponse.ok) headers.set("set-cookie", expiredBrowserCredential());
    return new Response(brokerResponse.body, { status: brokerResponse.status, headers: privateHeaders(Object.fromEntries(headers)) });
  }
  throw new BrokerError(404, "Not found.");
}

function health(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET") throw new BrokerError(405, "Method not allowed.", { allow: "GET" });
  const configured = Boolean(env.CHALK_API_KEY?.trim() && env.CHALK_API_URL?.trim() && env.CHALK_SPACE_ID?.trim() && env.CHALK_SYNC_URL?.trim() && env.CHALK_TENANT_ID?.trim() && env.EPISODE_LEASES);
  return json(configured ? 200 : 503, { service: "chalk-episode-broker", status: configured ? "ok" : "unconfigured" });
}

function episodeLeaseStub(env: WorkerEnv, spaceInviteToken: string): DurableObjectStubLike {
  return env.EPISODE_LEASES.get(env.EPISODE_LEASES.idFromName(spaceInviteToken));
}

function internalRequest(stub: DurableObjectStubLike, path: string, body: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`https://episode-lease.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function enforceRateLimit(binding: WorkerEnv["CREATE_RATE_LIMITER"], key: string): Promise<void> {
  if (!(await binding.limit({ key })).success) throw new BrokerError(429, "Too many Episode broker requests. Try again shortly.", { "retry-after": "60" });
}

async function anonymousRateKey(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function browserCredential(spaceInviteToken: string, participantCredentialId: string): string {
  return `${browserCredentialCookie}=${spaceInviteToken}.${participantCredentialId}; HttpOnly; Secure; SameSite=Strict; Path=${brokerPath}; Max-Age=${episodeDeadlineSeconds}`;
}

function expiredBrowserCredential(): string {
  return `${browserCredentialCookie}=; HttpOnly; Secure; SameSite=Strict; Path=${brokerPath}; Max-Age=0`;
}

function structuredLog(event: string, fields: Readonly<Record<string, boolean | number | string>>): void {
  console.log(JSON.stringify({ component: "episode-broker", event, ...fields }));
}
