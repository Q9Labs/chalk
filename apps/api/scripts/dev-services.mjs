import { manageLocalService } from "../../../scripts/dev/local-service.mjs";
const command = process.argv[2] || "start";
for (const service of command === "start" ? ["postgres", "redis"] : ["redis", "postgres"]) console.log(await manageLocalService(service, command === "urls" ? "url" : command));
