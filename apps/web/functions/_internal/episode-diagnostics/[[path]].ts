// fallow-ignore-file unused-file
import { handleEpisodeDiagnosticsGateway, type EpisodeDiagnosticsGatewayEnv } from "../../../src/server/episode-diagnostics-gateway";

export const onRequest: PagesFunction<EpisodeDiagnosticsGatewayEnv> = ({ request, env }) => handleEpisodeDiagnosticsGateway(request, env);
