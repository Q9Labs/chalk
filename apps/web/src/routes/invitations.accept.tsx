import { createFileRoute } from "@tanstack/react-router";
import { AcceptInvitationPage } from "../components/dashboard/AcceptInvitationPage";

export const Route = createFileRoute("/invitations/accept")({ component: AcceptInvitationPage });
