import { Effect } from "effect";
import { parseAccessGrant, type AccessGrant } from "../access/grant.js";
import { createChalkEffectClient } from "../client.js";
import type { PublicSpaceArrival as GeneratedPublicSpaceArrival, PublicSpaceCreated as GeneratedPublicSpaceCreated } from "../generated/schemas.js";
import type {
  ArriveBySpacePublicInviteInput,
  ChalkPublicClient,
  ChalkPublicClientOptions,
  ChalkPublicIdempotencyOptions,
  CreatePublicSpaceInput,
  PublicArrivalOptions,
  PublicArrivalReference,
  PublicLeaveOptions,
  PublicRefreshAccessInput,
  PublicSpaceArrival,
  PublicSpaceCreated,
  PublicStatus,
} from "./types.js";

export function createChalkPublicClient(options: ChalkPublicClientOptions): ChalkPublicClient {
  const baseClientOptions = {
    baseUrl: options.baseUrl,
    credentials: options.credentials ?? (options.runtime === "react-native" ? undefined : "include"),
    fetch: options.fetch,
    telemetry: options.telemetry,
  };

  const createClient = (guestCredential: string | undefined, requestInit?: RequestInit) =>
    createChalkEffectClient({
      ...baseClientOptions,
      ...(requestInit ? { fetch: requestInitFetch(options.fetch, requestInit) } : {}),
      headers: requestHeaders(options, guestCredential),
    });

  const createPublicSpace = async (input: CreatePublicSpaceInput, idempotency?: ChalkPublicIdempotencyOptions): Promise<PublicSpaceCreated> => {
    const client = await Effect.runPromise(createClient(undefined));
    const response = await Effect.runPromise(
      client.spaces.createPublicSpace({
        headers: { "Idempotency-Key": idempotencyKey(idempotency) },
        payload: { display_name: required(input.displayName, "displayName") },
      }),
    );
    return publicSpaceCreated(response);
  };

  const arriveBySpacePublicInvite = async (input: ArriveBySpacePublicInviteInput, arrival?: PublicArrivalOptions): Promise<PublicSpaceArrival> => {
    const client = await Effect.runPromise(createClient(arrival?.guestCredential ?? options.guestCredential));
    const response = await Effect.runPromise(
      client.spaces.arriveBySpacePublicInvite({
        headers: {
          "Idempotency-Key": idempotencyKey(arrival),
          ...(arrival?.arrivalHandle === undefined ? {} : { "X-Chalk-Arrival-Handle": required(arrival.arrivalHandle, "arrivalHandle") }),
        },
        payload: {
          display_name: required(input.displayName, "displayName"),
          space_invite_token: required(input.spaceInviteToken, "spaceInviteToken"),
        },
      }),
    );
    return publicSpaceArrival(response);
  };

  const getSpacePublicInviteArrival = async (reference: PublicArrivalReference | string): Promise<PublicSpaceArrival> => {
    const normalized = arrivalReference(reference);
    const client = await Effect.runPromise(createClient(normalized.guestCredential ?? options.guestCredential));
    const response = await Effect.runPromise(
      client.spaces.getSpacePublicInviteArrival({
        headers: { "X-Chalk-Arrival-Handle": normalized.arrivalHandle },
      }),
    );
    return publicSpaceArrival(response);
  };

  const refreshSpacePublicInviteAccess = async (input: PublicRefreshAccessInput | string, arrival?: PublicArrivalOptions): Promise<AccessGrant> => {
    const normalized = refreshInput(input, arrival);
    const client = await Effect.runPromise(createClient(normalized.guestCredential ?? options.guestCredential));
    const response = await Effect.runPromise(
      client.spaces.refreshSpacePublicInviteAccess({
        headers: { "X-Chalk-Arrival-Handle": normalized.arrivalHandle },
        payload: { media_proof: required(normalized.mediaProof, "mediaProof") },
      }),
    );
    return parseAccessGrant(response);
  };

  const leaveSpacePublicInviteArrival = async (reference: PublicArrivalReference | string, leaveOptions?: PublicLeaveOptions): Promise<void> => {
    const normalized = arrivalReference(reference);
    const client = await Effect.runPromise(createClient(normalized.guestCredential ?? options.guestCredential, requestInitForLeave(leaveOptions)));
    await Effect.runPromise(
      client.spaces.leaveSpacePublicInviteArrival({
        headers: { "X-Chalk-Arrival-Handle": normalized.arrivalHandle },
      }),
    );
  };

  const getPublicStatus = async (): Promise<PublicStatus> => {
    const client = await Effect.runPromise(createClient(undefined));
    return Effect.runPromise(client.default.getPublicStatus({}));
  };

  return {
    arrive: arriveBySpacePublicInvite,
    arriveBySpacePublicInvite,
    create: createPublicSpace,
    createPublicSpace,
    getPublicStatus,
    getSpacePublicInviteArrival,
    leave: leaveSpacePublicInviteArrival,
    leaveSpacePublicInviteArrival,
    refresh: refreshSpacePublicInviteAccess,
    refreshSpacePublicInviteAccess,
    status: getSpacePublicInviteArrival,
  };
}

export const createChalkPublicInviteClient = createChalkPublicClient;

function requestHeaders(options: ChalkPublicClientOptions, guestCredential: string | undefined): Readonly<Record<string, string>> {
  const headers = { ...options.headers };
  if (options.runtime === "react-native") {
    headers["X-Chalk-Client"] = "react-native";
    const credential = guestCredential ?? options.guestCredential;
    if (credential !== undefined) headers.Authorization = `ChalkGuest ${required(credential, "guestCredential")}`;
  }
  return headers;
}

function idempotencyKey(options: ChalkPublicIdempotencyOptions | undefined): string {
  return options?.idempotencyKey === undefined ? globalThis.crypto.randomUUID() : required(options.idempotencyKey, "idempotencyKey");
}

function arrivalReference(reference: PublicArrivalReference | string): PublicArrivalReference {
  if (typeof reference === "string") return { arrivalHandle: required(reference, "arrivalHandle") };
  return { arrivalHandle: required(reference.arrivalHandle, "arrivalHandle"), guestCredential: reference.guestCredential };
}

function refreshInput(input: PublicRefreshAccessInput | string, arrival: PublicArrivalOptions | undefined): PublicRefreshAccessInput & { readonly arrivalHandle: string } {
  const values =
    typeof input === "string"
      ? { arrivalHandle: arrival?.arrivalHandle, guestCredential: arrival?.guestCredential, mediaProof: input }
      : { arrivalHandle: input.arrivalHandle ?? arrival?.arrivalHandle, guestCredential: input.guestCredential ?? arrival?.guestCredential, mediaProof: input.mediaProof };
  return {
    ...values,
    arrivalHandle: required(values.arrivalHandle ?? "", "arrivalHandle"),
  };
}

function requestInitForLeave(options: PublicLeaveOptions | undefined): RequestInit | undefined {
  if (options?.keepalive === undefined) return undefined;
  return { keepalive: options.keepalive };
}

function requestInitFetch(fetchImplementation: typeof globalThis.fetch | undefined, requestInit: RequestInit): typeof globalThis.fetch {
  const implementation = fetchImplementation ?? globalThis.fetch;
  return (input, init) => implementation(input, { ...init, ...requestInit });
}

function publicSpaceCreated(value: GeneratedPublicSpaceCreated): PublicSpaceCreated {
  const { arrival, ...created } = value;
  return { ...created, arrival: publicSpaceArrival(arrival) };
}

function publicSpaceArrival(value: GeneratedPublicSpaceArrival): PublicSpaceArrival {
  const { access, ...arrival } = value;
  if (access === undefined) return arrival;
  return { ...arrival, access: access === null ? null : parseAccessGrant(access) };
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}
