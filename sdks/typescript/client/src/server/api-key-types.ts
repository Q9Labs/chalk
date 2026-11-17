import type { Pagination } from "./types.js";

export type APIKey = {
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly expires_at: string;
  readonly id: string;
  readonly key_prefix: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly scopes: readonly string[];
  readonly tenant_id: string;
  readonly updated_at: string;
};
export type APIKeyList = {
  readonly api_keys: readonly APIKey[];
  readonly pagination: Pagination;
};
export type APIKeyWithSecret = {
  readonly api_key: APIKey;
  readonly secret: string;
};
export type CreateAPIKeyInput = {
  readonly expiresAt: string;
  readonly name: string;
  readonly scopes: readonly string[];
};
export type ListAPIKeysInput = {
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type RotateAPIKeyInput = {
  readonly expiresAt?: string | null;
};
