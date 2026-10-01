import { createFileRoute } from "@tanstack/react-router";
import { RequestPasswordResetPage } from "../components/dashboard/PasswordResetPage";

export const Route = createFileRoute("/forgot-password")({ component: RequestPasswordResetPage });
