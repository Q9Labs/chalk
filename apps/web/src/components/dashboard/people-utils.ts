import type { TenantRole } from "../../lib/dashboard-api";

export const roleLabels: Record<TenantRole, string> = { owner: "Owner", collaborator: "Collaborator", observer: "Observer" };
export const roles: TenantRole[] = ["owner", "collaborator", "observer"];

export function roleFromValue(value: string): TenantRole | undefined {
  return roles.find((role) => role === value);
}

export function roleName(value: string): string {
  const role = roleFromValue(value);
  return role ? roleLabels[role] : value;
}

export function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}
