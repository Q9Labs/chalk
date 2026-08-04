import { createFileRoute } from "@tanstack/react-router";
import { ContractPage } from "../components/dashboard/ContractPage";
export const Route = createFileRoute("/_app/developer")({ component: () => <ContractPage kind="developer" /> });
