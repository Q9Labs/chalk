import { createFileRoute } from "@tanstack/react-router";
import { AcceptInvitationPage } from "../components/account/AcceptInvitationPage";

export const Route = createFileRoute("/invitations/accept")({ component: AcceptInvitationPage });
