import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const mobileAppRoot = join(process.cwd(), "apps", "mobile");

if (!existsSync(join(mobileAppRoot, "package.json"))) {
  console.log("[patch-realtimekit-react-native] skipped: apps/mobile not present");
  process.exit(0);
}

const packageJsonPath = [
  join(mobileAppRoot, "node_modules", "@cloudflare", "realtimekit-react-native", "package.json"),
  join(process.cwd(), "node_modules", "@cloudflare", "realtimekit-react-native", "package.json"),
].find((candidate) => existsSync(candidate));

if (!packageJsonPath) {
  console.log("[patch-realtimekit-react-native] skipped: @cloudflare/realtimekit-react-native not installed");
  process.exit(0);
}
const packageRoot = dirname(packageJsonPath);
const stringsXmlPath = join(packageRoot, "android", "src", "main", "res", "values", "strings.xml");
const blobAuthorityName = "blob_provider_authority";
const blobAuthorityValue = "com.cloudflare.realtimekit.expo.blobs";

const nextContents = `<resources>
  <string name="${blobAuthorityName}">${blobAuthorityValue}</string>
</resources>
`;

mkdirSync(dirname(stringsXmlPath), { recursive: true });

let currentContents = "";

try {
  currentContents = readFileSync(stringsXmlPath, "utf8");
} catch {
  currentContents = "";
}

if (currentContents.includes(`name="${blobAuthorityName}"`)) {
  process.exit(0);
}

writeFileSync(stringsXmlPath, nextContents, "utf8");
console.log(`[patch-realtimekit-react-native] wrote ${stringsXmlPath}`);
