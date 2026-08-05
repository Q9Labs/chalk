export { EpisodeLease } from "./episode-lease";
import type { WorkerEnv } from "./contracts";
import { handleBrokerRequest } from "./worker";

export default {
  fetch(request: Request, environment: WorkerEnv): Promise<Response> {
    return handleBrokerRequest(request, environment);
  },
};
