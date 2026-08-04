// fallow-ignore-file unused-file
import { handleAccountBoundary, type AccountBoundaryEnv } from "../../src/server/account-boundary";

export const onRequest: PagesFunction<AccountBoundaryEnv> = ({ request, env }) => handleAccountBoundary(request, env);
