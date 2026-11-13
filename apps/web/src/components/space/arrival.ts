import { canonicalSpaceInviteLink, DEFAULT_INVITE_ORIGIN, entranceStep, verifiedSpaceInviteLink, type ChalkPublicClient, type PublicSpaceArrival } from "@q9labsai/chalk-client";
import { admitPublicSpace } from "../../lib/chalk-access";
import type { ArrivalOutcome, WaitingArrival } from "./entrance-machine";
import { declinedFailure, neutralSpaceError } from "./entry-failure";

/** What asking to enter a Space returned: the server's answer and the link that now names the Space. */
export type ArrivedSpace = {
  readonly arrival: PublicSpaceArrival;
  readonly canonicalSlug: string;
  readonly inviteLink: string;
  readonly spaceName?: string;
};

/** Joins the Space an invite token names, or creates a new public Space when the visitor has no token. */
export async function arriveAtSpace(client: ChalkPublicClient, options: { readonly displayName: string; readonly slug: string | undefined; readonly inviteToken: string | undefined }): Promise<ArrivedSpace> {
  const origin = globalThis.location?.origin ?? DEFAULT_INVITE_ORIGIN;
  if (options.inviteToken) {
    const arrival = await client.arrive({ spaceInviteToken: options.inviteToken, displayName: options.displayName });
    const canonicalSlug = arrival.space?.slug ?? options.slug;
    if (!canonicalSlug) throw new Error(neutralSpaceError);
    return { arrival, canonicalSlug, inviteLink: canonicalSpaceInviteLink(origin, canonicalSlug, options.inviteToken), spaceName: arrival.space?.name };
  }
  const created = await client.create({ displayName: options.displayName });
  return { arrival: created.arrival, canonicalSlug: created.space.slug, inviteLink: verifiedSpaceInviteLink(origin, created.space.slug, created.invite_link), spaceName: created.space.name };
}

/** Puts the Space's own link in the address bar. An arrival the page could not move to is given back. */
export async function followArrivalLink(client: ChalkPublicClient, arrived: ArrivedSpace, navigate: (canonicalSlug: string, inviteLink: string) => Promise<void>): Promise<void> {
  try {
    await navigate(arrived.canonicalSlug, arrived.inviteLink);
  } catch (cause) {
    await leaveArrival(client, arrived.arrival);
    throw cause;
  }
}

/** A visitor who was let in without access asks the same invite again with the same handle, which returns the access. */
export async function reArrive(client: ChalkPublicClient, arrivalHandle: string, displayName: string, inviteToken: string | undefined): Promise<PublicSpaceArrival> {
  if (!inviteToken) throw new Error(neutralSpaceError);
  return client.arrive({ spaceInviteToken: inviteToken, displayName: displayName.trim() }, { arrivalHandle });
}

/** Gives back an admission the entrance no longer wants. Any other outcome holds nothing to give back. */
export function releaseAdmission(outcome: ArrivalOutcome): void {
  if (outcome.type === "admitted") void outcome.joined.session.leave().catch(() => undefined);
}

export async function leaveArrival(client: ChalkPublicClient, arrival: PublicSpaceArrival): Promise<void> {
  if (arrival.arrival_handle) await client.leave({ arrivalHandle: arrival.arrival_handle });
}

/** Turns the server's answer about an arrival into what the entrance does next. */
export async function arrivalEvent(client: ChalkPublicClient, arrival: PublicSpaceArrival, link: Pick<ArrivedSpace, "inviteLink" | "spaceName">, again: (arrivalHandle: string) => Promise<PublicSpaceArrival>): Promise<ArrivalOutcome> {
  const step = entranceStep(arrival);
  switch (step.state) {
    case "declined":
      return { type: "failed", failure: declinedFailure(step.reason) };
    case "pending": {
      const waiting: WaitingArrival = { arrival, ...link };
      return { type: "waitingForHost", waiting };
    }
    case "admitted":
      return { type: "admitted", joined: { ...admitPublicSpace(client, arrival), ...link } };
    case "admitted_without_access": {
      if (!arrival.arrival_handle) throw new Error("This Space is not ready yet.");
      return { type: "admitted", joined: { ...admitPublicSpace(client, await again(arrival.arrival_handle)), ...link } };
    }
  }
}
