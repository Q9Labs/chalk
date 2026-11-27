import { Schema } from "effect";
import { UUIDSchema } from "@q9labsai/chalk-client/effect";
import { run } from "./engine";
import type { Engine } from "./engine";
import type { HandoverDTO } from "../src/lib/dashboard/contracts";
import { DashboardError } from "./http";

function dto(handover: { id: string; tenant_id: string; status: string; expires_at: string; accepted_at: string | null; recipient_email: string }, email: string): HandoverDTO {
  return { id: handover.id, tenantId: handover.tenant_id, status: handover.status as HandoverDTO["status"], expiresAt: handover.expires_at, acceptedAt: handover.accepted_at, recipientMatches: handover.recipient_email === email.toLowerCase() };
}

export async function handoverPage(engine: Engine, handoverId: string, email: string): Promise<HandoverDTO> {
  const handover = await run(engine.api.tenants.getTenantHandoverAcceptance({ params: { handover_id: Schema.decodeUnknownSync(UUIDSchema)(handoverId) } }));
  return dto(handover, email);
}

export async function acceptHandover(engine: Engine, handoverId: string, person: { email: string; name: string }): Promise<HandoverDTO> {
  try {
    const handover = await run(engine.api.tenants.acceptTenantHandover({ params: { handover_id: Schema.decodeUnknownSync(UUIDSchema)(handoverId) }, payload: { recipient_email: person.email, recipient_name: person.name } }));
    return dto(handover, person.email);
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw error;
  }
}
