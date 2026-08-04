import { createFileRoute } from "@tanstack/react-router";
import { ContractPage } from "../components/dashboard/ContractPage";
export const Route = createFileRoute("/_app/episodes")({ component: () => <ContractPage kind="episodes" /> });
