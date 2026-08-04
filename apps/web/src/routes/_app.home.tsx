import { createFileRoute } from "@tanstack/react-router";
import { ProductHome } from "../components/dashboard/ProductHome";
export const Route = createFileRoute("/_app/home")({ component: ProductHome });
