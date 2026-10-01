import { createFileRoute } from "@tanstack/react-router";
import { PeoplePage } from "../components/dashboard/PeoplePage";
export const Route = createFileRoute("/_app/people")({ component: PeoplePage });
