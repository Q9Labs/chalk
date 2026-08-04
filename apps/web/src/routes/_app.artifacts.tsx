import { createFileRoute } from "@tanstack/react-router";
import { ContractPage } from "../components/dashboard/ContractPage";
export const Route = createFileRoute("/_app/artifacts")({ component: () => <ContractPage kind="artifacts" /> });
