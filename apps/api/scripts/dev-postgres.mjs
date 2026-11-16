import { manageLocalService } from "../../../scripts/dev/local-service.mjs";
console.log(await manageLocalService("postgres", process.argv[2]));
