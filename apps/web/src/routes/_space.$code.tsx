import { parseInviteCode } from "@q9labsai/chalk-client";
import { createFileRoute, notFound, redirect, rootRouteId } from "@tanstack/react-router";

export const Route = createFileRoute("/_space/$code")({
  beforeLoad: ({ params }) => {
    const code = parseInviteCode(params.code);
    if (!code) throw notFound({ routeId: rootRouteId });
    if (params.code !== code) throw redirect({ to: "/$code", params: { code }, replace: true });
  },
});
