import { BrokerError, brokerPath, browserSessionCookie, meetingLifetimeSeconds, type DurableObjectStubLike, type WorkerEnv } from "./contracts";
import { accessInput, browserSessionInput, cookieValue, emptyInput, json, privateHeaders, randomCapability, readJSON, requireOrigin, traceContext } from "./http";

type Log = (event: string, fields: Readonly<Record<string, boolean | number | string>>) => void;

export async function handleBrokerRequest(request: Request, env: WorkerEnv, log: Log = structuredLog): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  let response: Response;
  try {
    response = await route(request, env, url);
  } catch (error) {
    const status = error instanceof BrokerError ? error.status : 502;
    const message = error instanceof BrokerError ? error.message : "The meeting broker could not complete the request.";
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
  requireOrigin(request, env.CHALK_APP_ORIGIN);
  const body = await readJSON(request);
  const trace = traceContext(request);

  if (url.pathname === `${brokerPath}/browser-session`) {
    const input = browserSessionInput(body);
    await enforceRateLimit(env.CREATE_RATE_LIMITER, await anonymousRateKey(request));
    const existingSession = cookieValue(request.headers.get("cookie"));
    const resume = Boolean(input.inviteToken && existingSession?.inviteToken === input.inviteToken);
    const inviteToken = input.inviteToken ?? randomCapability();
    const browserSessionId = resume ? existingSession!.browserSessionId : randomCapability();
    const stub = meetingStub(env, inviteToken);
    const brokerResponse = await internalRequest(stub, "/browser-session", {
      action: resume ? "resume" : input.inviteToken ? "join" : "create",
      browserSessionId,
      displayName: input.displayName,
      trace,
    });
    if (!brokerResponse.ok) return brokerResponse;
    const responseBody = (await brokerResponse.json()) as Record<string, unknown>;
    return json(201, { ...responseBody, inviteToken }, { "set-cookie": sessionCookie(inviteToken, browserSessionId) });
  }

  const session = cookieValue(request.headers.get("cookie"));
  if (!session) throw new BrokerError(401, "The browser session is missing or expired.");
  await enforceRateLimit(env.SESSION_RATE_LIMITER, session.browserSessionId);
  const stub = meetingStub(env, session.inviteToken);

  if (url.pathname === `${brokerPath}/access`) {
    const input = accessInput(body);
    return internalRequest(stub, "/access", { ...input, browserSessionId: session.browserSessionId, trace });
  }
  if (url.pathname === `${brokerPath}/cleanup`) {
    emptyInput(body);
    const brokerResponse = await internalRequest(stub, "/cleanup", { browserSessionId: session.browserSessionId, trace });
    const headers = new Headers(brokerResponse.headers);
    if (brokerResponse.ok) headers.set("set-cookie", expiredSessionCookie());
    return new Response(brokerResponse.body, { status: brokerResponse.status, headers: privateHeaders(Object.fromEntries(headers)) });
  }
  throw new BrokerError(404, "Not found.");
}

function health(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET") throw new BrokerError(405, "Method not allowed.", { allow: "GET" });
  const configured = Boolean(env.CHALK_API_KEY?.trim() && env.CHALK_API_URL?.trim() && env.CHALK_ROOM_ID?.trim() && env.CHALK_SYNC_URL?.trim() && env.CHALK_TENANT_ID?.trim() && env.MEETING_SESSIONS);
  return json(configured ? 200 : 503, { service: "chalk-meeting-broker", status: configured ? "ok" : "unconfigured" });
}

function meetingStub(env: WorkerEnv, inviteToken: string): DurableObjectStubLike {
  return env.MEETING_SESSIONS.get(env.MEETING_SESSIONS.idFromName(inviteToken));
}

function internalRequest(stub: DurableObjectStubLike, path: string, body: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`https://meeting-session.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function enforceRateLimit(binding: WorkerEnv["CREATE_RATE_LIMITER"], key: string): Promise<void> {
  if (!(await binding.limit({ key })).success) throw new BrokerError(429, "Too many meeting requests. Try again shortly.", { "retry-after": "60" });
}

async function anonymousRateKey(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sessionCookie(inviteToken: string, browserSessionId: string): string {
  return `${browserSessionCookie}=${inviteToken}.${browserSessionId}; HttpOnly; Secure; SameSite=Strict; Path=${brokerPath}; Max-Age=${meetingLifetimeSeconds}`;
}

function expiredSessionCookie(): string {
  return `${browserSessionCookie}=; HttpOnly; Secure; SameSite=Strict; Path=${brokerPath}; Max-Age=0`;
}

function structuredLog(event: string, fields: Readonly<Record<string, boolean | number | string>>): void {
  console.log(JSON.stringify({ component: "meeting-broker", event, ...fields }));
}
