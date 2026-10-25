import { createFileRoute, notFound, redirect, rootRouteId } from "@tanstack/react-router";

export const Route = createFileRoute("/_space/$code")({
  beforeLoad: async ({ params }) => {
    const { parseInviteCode } = await import("@q9labsai/chalk-client/invites");
    const code = parseInviteCode(params.code);
    if (!code) throw notFound({ routeId: rootRouteId });
    if (params.code !== code) throw redirect({ to: "/$code", params: { code }, replace: true });
  },
});
