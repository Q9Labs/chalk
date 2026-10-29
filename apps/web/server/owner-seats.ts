import { z } from "zod";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import { clearLegacySeatCookies, readCookie, seal, unseal, writeCookie } from "./cookies";
import { DashboardError } from "./http";

const seatSchema = z.object({ userId: z.string(), sessionId: z.string(), spaceId: z.uuid(), episodeId: z.uuid(), participantId: z.uuid(), generation: z.number().int().positive(), expiresAt: z.number(), joinKey: z.uuid().optional() });
export type OwnerSeat = z.infer<typeof seatSchema>;
// A bounded compatibility/history cache, not the authority of active tabs.
const seatsSchema = z.array(seatSchema).max(4);

async function cachedSeats(request: Request, env: DashboardEnvironment): Promise<OwnerSeat[]> {
  const encoded = readCookie(request, env, "seats");
  return encoded ? seatsSchema.parse(await unseal(encoded, env.SESSION_SECRET, "owner-seats")) : [];
}
function belongsTo(seat: OwnerSeat, person: Identity): boolean {
  return seat.userId === person.userId && seat.sessionId === person.sessionId && seat.expiresAt > Date.now();
}
export async function readOwnerSeat(request: Request, env: DashboardEnvironment, person: Identity, input: { spaceId: string; joinKey?: string; ownerSeat?: string }): Promise<OwnerSeat> {
  let seat: OwnerSeat | undefined;
  if (input.ownerSeat) seat = seatSchema.parse(await unseal(input.ownerSeat, env.SESSION_SECRET, "owner-seat"));
  else {
    seat = (await cachedSeats(request, env)).find((entry) => entry.spaceId === input.spaceId && (input.joinKey === undefined || entry.joinKey === input.joinKey));
    if (!seat) {
      const legacy = readCookie(request, env, input.joinKey ? `seat_${input.spaceId}_${input.joinKey}` : `seat_${input.spaceId}`);
      if (legacy) seat = { ...seatSchema.parse(await unseal(legacy, env.SESSION_SECRET, "owner-seat")), ...(input.joinKey ? { joinKey: input.joinKey } : {}) };
    }
  }
  if (!seat || !belongsTo(seat, person) || seat.spaceId !== input.spaceId || (input.joinKey !== undefined && seat.joinKey !== input.joinKey)) throw new DashboardError(401, "join_required");
  return seat;
}
export async function writeOwnerSeat(request: Request, response: Response, env: DashboardEnvironment, person: Identity, seat: OwnerSeat): Promise<void> {
  const previous = (await cachedSeats(request, env)).filter((entry) => belongsTo(entry, person) && !(entry.spaceId === seat.spaceId && entry.joinKey === seat.joinKey));
  const seats = [seat, ...previous].slice(0, 4);
  const expiresAt = Math.max(...seats.map((entry) => entry.expiresAt));
  writeCookie(response, env, "seats", await seal(seats, env.SESSION_SECRET, "owner-seats"), Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
  clearLegacySeatCookies(response, request, env);
}
export async function viewerSeat(request: Request, env: DashboardEnvironment, person: Identity, spaceId: string, episodeId: string): Promise<string | null> {
  try {
    const seat = await readOwnerSeat(request, env, person, { spaceId });
    return seat.episodeId === episodeId ? seat.participantId : null;
  } catch (error) {
    if (error instanceof DashboardError && error.code === "join_required") return null;
    throw error;
  }
}
