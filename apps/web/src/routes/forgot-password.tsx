import { createFileRoute } from "@tanstack/react-router";
import { RequestPasswordResetPage } from "../components/account/PasswordResetPage";

export const Route = createFileRoute("/forgot-password")({ component: RequestPasswordResetPage });
