import { manageLocalService } from "../../../scripts/dev/local-service.mjs";
console.log(await manageLocalService("redis", process.argv[2]));
