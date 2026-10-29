import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { syncWhiteboardAssets } from "../../../features/whiteboard/web/sync-assets";

const publicDir = resolve(import.meta.dirname, "../public");
const blankHtml = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>\n';
const privacyPath = resolve(publicDir, "privacy-policy/index.html");
if (!existsSync(privacyPath) || readFileSync(privacyPath, "utf8") !== blankHtml) {
  mkdirSync(dirname(privacyPath), { recursive: true });
  writeFileSync(privacyPath, blankHtml);
}
syncWhiteboardAssets(publicDir);
