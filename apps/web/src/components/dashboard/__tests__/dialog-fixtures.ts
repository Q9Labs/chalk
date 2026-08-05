import type { Space } from "../../../lib/dashboard-api";

export const dashboardTestTenantID = "tenant-1";

export function dashboardTestSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: "space-1",
    tenant_id: dashboardTestTenantID,
    name: "Product studio",
    slug: "product-studio",
    media_plane: "cf_rtk",
    metadata: {},
    recurring_policy: {},
    admission_policy: { mode: "open" },
    default_episode_duration_seconds: 86_400,
    maximum_episode_duration_seconds: 86_400,
    linger_window_seconds: 0,
    archived: false,
    archived_at: null,
    roles: [],
    created_by_user_id: null,
    updated_at: "2026-08-04T09:00:00Z",
    created_at: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

export function installDialogMethods() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    },
  });
}
