import { createFileRoute } from "@tanstack/react-router";
import { SpacesPage } from "../components/dashboard/SpacesPage";
export const Route = createFileRoute("/_app/spaces")({ component: SpacesPage });
