import { createFileRoute } from "@tanstack/react-router";
import { AuthPage } from "../components/dashboard/AuthPage";

export const Route = createFileRoute("/sign-up")({ component: () => <AuthPage mode="sign-up" /> });
