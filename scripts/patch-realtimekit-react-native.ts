import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packageJsonPath = require.resolve("@cloudflare/realtimekit-react-native/package.json", {
  paths: [join(process.cwd(), "apps", "mobile")],
});
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
