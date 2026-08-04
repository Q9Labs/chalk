import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

export function dashboardSource(fileName: string): string {
  return readFileSync(joinPath(process.cwd(), "src/components/dashboard", fileName), "utf8");
}
