import type { ChalkIdempotencyOptions } from "./types.js";

export type TenantHandoverActor = {
  readonly kind: "service" | "operator";
  readonly service_id?: string;
  readonly operator?: string;
};
export type TenantHandover = {
  readonly accepted_at: string | null;
  readonly accepted_by_user_id: string | null;
  readonly canceled_at: string | null;
  readonly canceled_by: TenantHandoverActor | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly from_service_id: string;
  readonly id: string;
  readonly initiated_by: TenantHandoverActor;
  readonly recipient_email: string;
  readonly status: "pending" | "accepted" | "canceled" | "expired";
  readonly tenant_id: string;
  readonly to_service_id: string;
  readonly updated_at: string;
};
export type CreateTenantHandoverInput = {
  readonly recipientEmail: string;
  readonly expiresInSeconds?: number;
};
export type TenantHandoverClient = {
  create(input: CreateTenantHandoverInput, options?: ChalkIdempotencyOptions): Promise<TenantHandover>;
  get(handoverId: string): Promise<TenantHandover>;
  cancel(handoverId: string): Promise<TenantHandover>;
};
