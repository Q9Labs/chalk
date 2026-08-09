export { MeetingSession } from "./meeting-session";
import type { WorkerEnv } from "./contracts";
import { handleBrokerRequest } from "./worker";

export default {
  fetch(request: Request, environment: WorkerEnv): Promise<Response> {
    return handleBrokerRequest(request, environment);
  },
};
