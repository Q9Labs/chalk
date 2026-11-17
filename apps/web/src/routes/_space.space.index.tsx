import { createFileRoute, redirect } from "@tanstack/react-router";

import { startCall } from "../components/dashboard/language-choice";
import { DashboardRequestError, intentKey, loadSession } from "../lib/dashboard/client";
import { hasSignedInHint } from "../lib/signed-in-hint";

/** Starting a call from the site: a signed-in person gets a call from their own account, the same as from the dashboard. Everyone else gets the anonymous entrance. */
export const Route = createFileRoute("/_space/space/")({
  beforeLoad: async () => {
    if (!hasSignedInHint()) return;
    try {
      await loadSession();
    } catch (error) {
      if (error instanceof DashboardRequestError && error.status === 401) return;
      throw error;
    }
    const { call } = await startCall(intentKey());
    throw redirect({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id }, replace: true });
  },
});
