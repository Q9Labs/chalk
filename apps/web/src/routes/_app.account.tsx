import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../components/dashboard/AccountPage";
export const Route = createFileRoute("/_app/account")({ component: AccountPage });
